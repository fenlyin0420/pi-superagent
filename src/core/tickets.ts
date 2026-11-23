/**
 * Tickets: from the accept that creates one to the end that releases it
 * (docs/001-domain.md, docs/002-authorization.md, docs/003-execution.md).
 *
 * A Ticket defines its own state, keeps the Threads it subscribes to, the Inputs
 * its worker received, the Reports it made and the Threads a Source made it
 * follow. It never follows an Executor session.
 */
import type {
	Assignment,
	Input,
	Ms,
	Policy,
	Strength,
	Subscription,
	ThreadKey,
	Ticket,
	TicketEndOutcome,
	TicketId,
	Trigger,
	TriggerId,
} from "./model.js";
import { EnginePart, type EngineOptions, UserError, followsDone, latestAssignment, latestReport, liveTicket, nextSeq, personInput, runningAssignment, settled, stoppedTicket, undeliveredInputs, waitsForPerson } from "./part.js";
import { policyEffectText } from "../policy.js";
import type { Replies } from "./replies.js";

const STATUS_REQUEST =
	"Report the current ticket status. This is a status-only request: do not resume implementation or perform external actions.";

export interface CreateTicketInput {
	decisionId: string;
	primary: Trigger;
	triggers: Trigger[];
	thread: ThreadKey;
	scope: string;
	strength: Strength;
	matchedRules: string[];
	policyVersion: number;
}

export class Tickets extends EnginePart {
	constructor(
		options: EngineOptions,
		private readonly replies: Replies,
	) {
		super(options);
	}

	/**
	 * 001: only an accept creates a Ticket, with its Mandate, its Subscriptions,
	 * its first Assignment and the acknowledgement the accept carries. The batch's
	 * Triggers become the Inputs its first launch renders.
	 */
	create(input: CreateTicketInput): Ticket {
		const at = this.now();
		const id = `ticket-${nextSeq(this.state, "ticket")}`;
		const name = this.shortName(input.scope, id);
		const ticket: Ticket = {
			id,
			name,
			source: input.primary.source,
			thread: input.primary.threads[0] ?? input.thread,
			mandate: {
				policyVersion: input.policyVersion,
				scope: input.scope,
				strength: input.strength,
				matchedRules: input.matchedRules,
				requester: input.primary.actor,
				receivedAs: input.primary.kind,
				triggerId: input.primary.id,
				triggerIds: input.triggers.map((trigger) => trigger.id),
			},
			origin: { triggerId: input.primary.id, triggerIds: input.triggers.map((trigger) => trigger.id) },
			execution: { name, directory: this.options.directoryFor?.(name) ?? name },
			follows: [],
			subscriptions: [],
			inputs: [],
			reports: [],
			assignmentIds: [],
			notes: [],
			createdAt: at,
			updatedAt: at,
		};
		this.state.tickets[id] = ticket;
		for (const trigger of input.triggers) {
			for (const key of trigger.threads) this.subscribe(ticket, key, trigger === input.primary ? "origin" : "attached");
			this.addInput(ticket, {
				id: `in-${id}-${trigger.id}`,
				ticketId: id,
				kind: "trigger",
				text: trigger.text,
				triggerId: trigger.id,
				at,
			});
		}
		const assignment = this.newAssignment(ticket);
		this.replies.accepted(ticket, input.primary);
		this.emit({ type: "ticket.created", at, ticketId: id, decisionId: input.decisionId, strength: ticket.mandate.strength });
		this.launch(ticket, assignment);
		return ticket;
	}

	/** 003: a Source makes an open Ticket follow a Thread, its own pull request's when the Ticket opened it. */
	bind(ticketId: TicketId, thread: ThreadKey, own: boolean): void {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		this.subscribe(ticket, thread, own ? "own" : "attached");
		const followed = ticket.follows.find((item) => item.thread === thread);
		if (followed === undefined) ticket.follows.push({ thread, own });
		else {
			followed.own ||= own;
			delete followed.closed;
		}
		ticket.updatedAt = this.now();
	}

	/**
	 * 003: a Thread closed. Each open Ticket that follows it records the close and
	 * ends once it is done with the Threads it follows, unless work resumed since
	 * the close is unfinished.
	 */
	threadClosed(thread: ThreadKey, outcome: "merged" | "closed", at: Ms): void {
		const record = this.state.threads[thread];
		if (record !== undefined) record.closed = { at, outcome };
		for (const ticket of Object.values(this.state.tickets)) {
			const followed = ticket.follows.find((item) => item.thread === thread);
			if (followed === undefined || followed.closed !== undefined) continue;
			followed.closed = { at, outcome };
			ticket.updatedAt = this.now();
			if (!liveTicket(ticket)) continue;
			const done = followsDone(ticket);
			if (done === undefined || this.unfinished(ticket, at)) continue;
			this.end(ticket, "executor", done.outcome, done.at, done.outcome === "merged" ? "pull_merged" : "pull_closed");
		}
	}

	/** 002: an attached Trigger's Threads join the Ticket, and the Trigger reaches its worker as an Input. */
	attach(ticket: Ticket, trigger: Trigger, note?: string): void {
		for (const key of trigger.threads) this.subscribe(ticket, key, "attached");
		const text = note === undefined ? trigger.text : `${trigger.text}\n\nRouting note: ${note}`;
		this.addInput(ticket, {
			id: `in-${ticket.id}-${trigger.id}-attached`,
			ticketId: ticket.id,
			// 002: an ended Ticket resumes under its mandate on the attached message.
			kind: liveTicket(ticket) ? "trigger" : "resume",
			text,
			triggerId: trigger.id,
			at: this.now(),
		});
	}

	/**
	 * 002: a person's message on one of an ended Ticket's own Threads resumes it
	 * under the same Mandate, with no Eval and no Decision. A paused pass holds it;
	 * a Mandate the Policy no longer holds takes none of it.
	 */
	resume(ticket: Ticket): boolean {
		if (liveTicket(ticket) || stoppedTicket(ticket)) return false;
		const waiting = ticket.inputs.find((input) => input.kind === "resume" && input.deliveredAt === undefined);
		if (waiting === undefined) return false;
		if (!this.mandateHolds(ticket)) {
			this.refuse(ticket);
			return false;
		}
		if (this.paused()) {
			ticket.resumePending = true;
			return true;
		}
		const at = this.now();
		delete ticket.ended;
		delete ticket.resumePending;
		ticket.updatedAt = at;
		const assignment = this.newAssignment(ticket);
		this.launch(ticket, assignment);
		this.emit({ type: "ticket.resumed", at, ticketId: ticket.id, triggerId: waiting.triggerId ?? ticket.mandate.triggerId });
		return true;
	}

	/** Record an Input once and hand it to the worker: the current Assignment, or a launch that waits for one. */
	addInput(ticket: Ticket, input: Input): void {
		if (ticket.inputs.some((existing) => existing.id === input.id)) return;
		ticket.inputs.push(input);
		ticket.updatedAt = this.now();
		if (!liveTicket(ticket)) return;
		// 003: a blocked or failed Assignment takes no automatic Input until a person writes.
		if (waitsForPerson(this.state, ticket) && !personInput(this.state, input)) return;
		const latest = latestAssignment(this.state, ticket);
		if (latest === undefined || latest.state === "ended") return;
		if (latest.state === "running") this.deliverWaiting(ticket, latest);
		else this.launch(ticket, latest);
	}

	/** Hand the Inputs that wait to the Assignment that runs the Ticket. */
	deliverPending(ticket: Ticket): void {
		if (!liveTicket(ticket) || waitsForPerson(this.state, ticket)) return;
		const running = runningAssignment(this.state, ticket);
		if (running !== undefined) this.deliverWaiting(ticket, running);
	}

	/** 002: a fact from other work reaches the worker as plain text, which asks for nothing and grants nothing. */
	note(ticketId: TicketId, text: string): void {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		const at = this.now();
		ticket.notes.push({ at, text, by: "router" });
		this.addInput(ticket, { id: `in-${nextSeq(this.state, "input")}`, ticketId, kind: "note", text, at });
	}

	/** 003: ask a worker that reported `waiting` for its status; any other worker is left alone. */
	requestStatus(ticketId: TicketId): boolean {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket) || latestReport(ticket)?.kind !== "waiting") return false;
		this.addInput(ticket, {
			id: `in-${nextSeq(this.state, "input")}`,
			ticketId,
			kind: "status",
			text: STATUS_REQUEST,
			at: this.now(),
		});
		return true;
	}

	/** 002: a person's stop acts on the Ticket directly and withdraws its Mandate. */
	stop(ticketId: TicketId, reason?: string): void {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		this.end(ticket, "person", "stopped", this.now(), reason ?? "stopped_by_person");
	}

	/** 003: a retry ends the stalled Assignment and starts a new one in the same Session and directory. */
	retry(ticketId: TicketId): void {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		const latest = latestAssignment(this.state, ticket);
		if (latest === undefined || !this.canRetry(ticket)) throw new UserError("notRetryable");
		this.endAssignment(ticket, latest, "retried");
		this.requeueUntaken(ticket, latest);
		const assignment = this.newAssignment(ticket);
		this.launch(ticket, assignment);
	}

	/** 003: the host restarted mid-turn: a recovery note and the Inputs the worker did not take start again. */
	restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
		this.endAssignment(ticket, running, reason);
		this.requeueUntaken(ticket, running);
		this.addInput(ticket, { id: `in-${nextSeq(this.state, "input")}`, ticketId: ticket.id, kind: "recovery", text: note, at: this.now() });
		const assignment = this.newAssignment(ticket);
		this.launch(ticket, assignment);
	}

	/**
	 * 002: the worker found an attached Thread unrelated to its Ticket, so only
	 * that import drops, and the person's messages there it decided go back to
	 * routing. The Thread the Ticket started on and the Threads a Source made it
	 * follow stay subscribed.
	 */
	markUnrelated(ticketId: TicketId, thread: ThreadKey, reason: string): void {
		const ticket = this.require(ticketId);
		const record = this.state.threads[thread];
		const subscription = record?.subscriptions.find((item) => item.ticketId === ticket.id);
		if (record === undefined || subscription === undefined) throw new UserError("notFollowing");
		if (subscription.kind === "origin") throw new UserError("sourceThread");
		// 002: a Thread a Source made the Ticket follow, such as its pull request's, stays subscribed.
		if (subscription.kind === "own" || ticket.follows.some((item) => item.thread === thread)) throw new UserError("followedThread");
		const at = this.now();
		// The messages there it decided are handed back before the import drops, while the Ticket still owns them.
		for (const input of [...ticket.inputs]) {
			if (input.triggerId === undefined || ticket.handedBack?.includes(input.triggerId)) continue;
			const trigger = this.state.triggers[input.triggerId];
			if (trigger === undefined || !trigger.threads.includes(thread) || !this.owns(ticket, trigger)) continue;
			this.handback(ticket.id, trigger.id, reason);
		}
		subscription.dropped = { at, reason };
		ticket.subscriptions = ticket.subscriptions.filter((key) => key !== thread);
		ticket.updatedAt = at;
		this.emit({ type: "thread.unsubscribed", at, thread, ticketId, by: "executor" });
	}

	/** 001: a Thread followed only for context reaches the Ticket but lends it no authority and resumes nothing. */
	followForContext(ticketId: TicketId, thread: ThreadKey): void {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		this.subscribe(ticket, thread, "context");
	}

	/**
	 * 002: a worker hands a message back once, with its reason. It goes to a fresh
	 * Eval once no other live Ticket still owns it.
	 */
	handback(ticketId: TicketId, triggerId: TriggerId, reason: string): boolean {
		const ticket = this.require(ticketId);
		const trigger = this.requireTrigger(triggerId);
		if (!ticket.inputs.some((input) => input.triggerId === triggerId)) throw new UserError("notReached");
		ticket.handedBack ??= [];
		if (ticket.handedBack.includes(triggerId)) throw new UserError("handedBack");
		ticket.handedBack.push(triggerId);
		ticket.updatedAt = this.now();
		this.emit({ type: "trigger.handbacked", at: this.now(), triggerId, ticketId, reason });
		if (!this.owns(ticket, trigger)) return false;
		if (this.evalHolding(triggerId) !== undefined) return false;
		if (this.otherOwner(triggerId, ticketId)) return false;
		this.enqueueTrigger(this.thread(trigger.threads[0] ?? ticket.thread, trigger.source), triggerId);
		this.emit({ type: "trigger.requeued", at: this.now(), triggerId });
		return true;
	}

	/**
	 * 003: end a Ticket with its outcome. The Assignments it stops end with it,
	 * and the person's messages its worker never read go back to routing.
	 */
	end(ticket: Ticket, by: "executor" | "person" | "policy", outcome: TicketEndOutcome, at: Ms, reason?: string): void {
		if (!liveTicket(ticket)) return;
		const why = reason ?? outcome;
		const stopping = ticket.assignmentIds.flatMap((id) => {
			const assignment = this.state.assignments[id];
			return assignment !== undefined && assignment.state !== "ended" ? [assignment] : [];
		});
		ticket.ended = { at, by, reason: why, outcome };
		ticket.updatedAt = this.now();
		delete ticket.attention;
		delete ticket.resumePending;
		delete ticket.delivery;
		if (by === "person") ticket.stoppedAt = at;
		for (const assignment of stopping) {
			assignment.state = "ended";
			assignment.endedAt = at;
			assignment.endReason = why;
		}
		this.emit({ type: "ticket.ended", at, ticketId: ticket.id, by, outcome, reason: why });
		for (const assignment of stopping) {
			this.effect({ kind: "endAssignment", ticketId: ticket.id, assignmentId: assignment.id, reason: why });
		}
		// 002: a stop decides only the stopped Ticket's work; nothing of it goes to Eval again.
		if (outcome !== "stopped") this.releaseUnread(ticket);
	}

	/** 002: a person may drop every Subscription on a Thread at once. */
	dropSubscriptions(thread: ThreadKey): boolean {
		const record = this.state.threads[thread];
		if (record === undefined || record.subscriptions.length === 0) return false;
		const at = this.now();
		for (const subscription of record.subscriptions) {
			const ticket = this.state.tickets[subscription.ticketId];
			if (ticket !== undefined) {
				ticket.subscriptions = ticket.subscriptions.filter((key) => key !== thread);
				ticket.follows = ticket.follows.filter((item) => item.thread !== thread);
				ticket.updatedAt = at;
			}
			this.emit({ type: "thread.unsubscribed", at, thread, ticketId: subscription.ticketId, by: "person" });
		}
		record.subscriptions = [];
		return true;
	}

	/** 002: the Policy changed; a Ticket the change bears on receives an Input saying how. */
	noticePolicy(ticket: Ticket, from: Policy, to: Policy, codes: readonly string[]): void {
		this.addInput(ticket, {
			id: `in-${nextSeq(this.state, "input")}`,
			ticketId: ticket.id,
			kind: "policy",
			text: policyEffectText(from, to, ticket, codes),
			at: this.now(),
		});
	}

	// ------------------------------------------------------------- internals

	/** 002: the Ticket decides this message: a person's, on a Thread it is subscribed to for more than context. */
	private owns(ticket: Ticket, trigger: Trigger): boolean {
		if (trigger.actor.bot || stoppedTicket(ticket)) return false;
		const record = this.state.threads[trigger.threads[0] ?? ""];
		const subscription = record?.subscriptions.find((item) => item.ticketId === ticket.id);
		return subscription !== undefined && subscription.kind !== "context" && subscription.dropped === undefined;
	}

	private settledBy(triggerId: TriggerId): boolean {
		return Object.values(this.state.decisions).some((decision) => settled(decision) && decision.triggerIds.includes(triggerId));
	}

	private otherOwner(triggerId: TriggerId, except: TicketId): boolean {
		return Object.values(this.state.tickets).some(
			(ticket) =>
				ticket.id !== except &&
				!stoppedTicket(ticket) &&
				ticket.inputs.some((input) => input.triggerId === triggerId && input.readAt === undefined),
		);
	}

	/**
	 * 003: a close does not end the Ticket while work it resumed, retried or
	 * recovered after the close has no ready Report, or while its worker holds a
	 * person's follow-up it has not reported on since.
	 */
	private unfinished(ticket: Ticket, since: Ms): boolean {
		const answeredAt = ticket.reports.filter((report) => report.kind !== "progress").at(-1)?.at ?? 0;
		const taken = ticket.inputs.some((input) => personInput(this.state, input) && (input.readAt ?? 0) > answeredAt);
		if (taken) return true;
		const assignment = latestAssignment(this.state, ticket);
		if ((assignment?.startedAt ?? 0) <= since) return false;
		return latestReport(ticket)?.kind !== "ready" || undeliveredInputs(ticket).length > 0;
	}

	/** 003: a Ticket that ended, or cannot resume, lets go of what its worker never read. */
	private releaseUnread(ticket: Ticket): void {
		for (const input of ticket.inputs) {
			if (input.readAt !== undefined || input.triggerId === undefined) continue;
			if (input.kind !== "trigger" && input.kind !== "resume") continue;
			const trigger = this.state.triggers[input.triggerId];
			if (trigger === undefined) continue;
			if (this.evalHolding(trigger.id) !== undefined) continue;
			if (this.otherOwner(trigger.id, ticket.id)) continue;
			// 002: a message a Decision settled does not go back to routing.
			if (this.settledBy(trigger.id)) continue;
			this.enqueueTrigger(this.thread(trigger.threads[0] ?? ticket.thread, trigger.source), trigger.id);
			this.emit({ type: "trigger.requeued", at: this.now(), triggerId: trigger.id });
		}
	}

	/** 002: a Mandate the Policy no longer holds stays ended and takes none of the messages waiting for it. */
	private refuse(ticket: Ticket): void {
		delete ticket.resumePending;
		this.releaseUnread(ticket);
	}

	private canRetry(ticket: Ticket): boolean {
		// 003: retry is offered for a failed input delivery, or for a blocked or failed Report no person answered yet.
		return ticket.delivery !== undefined || waitsForPerson(this.state, ticket);
	}

	private subscribe(ticket: Ticket, thread: ThreadKey, kind: Subscription["kind"]): void {
		const record = this.thread(thread, ticket.source);
		const existing = record.subscriptions.find((item) => item.ticketId === ticket.id);
		if (existing === undefined) {
			record.subscriptions.push({ ticketId: ticket.id, kind, at: this.now() });
			this.emit({ type: "thread.subscribed", at: this.now(), thread, ticketId: ticket.id });
		} else {
			delete existing.dropped;
			// A Thread read for context only becomes the Ticket's own once it is attached or bound.
			if (kind !== "context" && existing.kind === "context") existing.kind = kind;
		}
		if (!ticket.subscriptions.includes(thread)) ticket.subscriptions.push(thread);
	}

	private newAssignment(ticket: Ticket): Assignment {
		const id = `asg-${nextSeq(this.state, "assignment")}`;
		const assignment: Assignment = {
			id,
			ticketId: ticket.id,
			state: "pending",
			sessionId: `sagent/${ticket.id}`,
			directory: ticket.execution.directory,
		};
		this.state.assignments[id] = assignment;
		ticket.assignmentIds.push(id);
		ticket.execution.assignmentId = id;
		ticket.updatedAt = this.now();
		delete ticket.delivery;
		return assignment;
	}

	/** 003: preparation runs once per Ticket; every Assignment after the first launches straight into the directory. */
	private launch(ticket: Ticket, assignment: Assignment): void {
		const prepared = ticket.assignmentIds.some((id) => this.state.assignments[id]?.preparedAt !== undefined);
		if (!prepared) this.effect({ kind: "prepare", ticketId: ticket.id, assignmentId: assignment.id });
		this.effect({ kind: "launch", ticketId: ticket.id, assignmentId: assignment.id });
	}

	private deliverWaiting(ticket: Ticket, assignment: Assignment): void {
		const waiting = undeliveredInputs(ticket).map((input) => input.id);
		if (waiting.length === 0) return;
		this.effect({ kind: "deliver", ticketId: ticket.id, assignmentId: assignment.id, inputIds: waiting });
	}

	private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
		assignment.state = "ended";
		assignment.endedAt = this.now();
		assignment.endReason = reason;
		this.emit({ type: "assignment.ended", at: this.now(), ticketId: ticket.id, assignmentId: assignment.id, reason });
		this.effect({ kind: "endAssignment", ticketId: ticket.id, assignmentId: assignment.id, reason });
	}

	/** 003: a retry or restart gives the new Assignment the messages the replaced one never took into history. */
	private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
		for (const input of ticket.inputs) {
			if (input.assignmentId !== replaced.id || input.readAt !== undefined) continue;
			delete input.deliveredAt;
			delete input.assignmentId;
		}
	}

	private shortName(scope: string, id: TicketId): string {
		const taken = new Set(Object.values(this.state.tickets).map((ticket) => ticket.execution.name));
		const slug = scope
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.split("-")
			.slice(0, 5)
			.join("-")
			.slice(0, 40);
		const name = slug === "" ? id : slug;
		return taken.has(name) ? `${name}-${id}` : name;
	}
}
