/**
 * The domain's single entry point (docs/000-design.md "Modules", docs/007 in the
 * reference). Every command runs inside one store transaction; external work is
 * queued through `Effects` inside that transaction, and the adapters perform it
 * after the commit. Nothing here is asynchronous.
 *
 * Callers receive a role's view of the Engine, never more: what Sources, the
 * router session, people, settings and the Executor may ask for.
 */
import type {
	AssignmentId,
	Candidate,
	DecisionId,
	DecisionKind,
	EvalId,
	InputId,
	Ms,
	Policy,
	ThreadKey,
	ThreadRecord,
	TicketId,
	Trigger,
	TriggerId,
} from "./model.js";
import type { Engine, EngineForExecutor, EngineForMainSession, EngineForPeople, EngineForSettings, EngineForSources, ReplyRequest, ReportInput } from "./ports.js";
import { EnginePart, type EngineOptions, UserError, liveTicket } from "./part.js";
import { Assignments } from "./assignments.js";
import { Evals } from "./evals.js";
import { Intake, type ReceiveResult } from "./intake.js";
import { Replies } from "./replies.js";
import { Tickets } from "./tickets.js";

export { UserError, USER_ERRORS, type DomainEvent, type EngineOptions, type UserErrorCode } from "./part.js";
export type { ReceiveResult } from "./intake.js";

export class DomainEngine extends EnginePart implements Engine {
	private readonly replies: Replies;
	private readonly tickets: Tickets;
	private readonly evals: Evals;
	private readonly assignments: Assignments;
	private readonly intake: Intake;

	constructor(options: EngineOptions) {
		super(options);
		this.replies = new Replies(options);
		this.tickets = new Tickets(options, this.replies);
		this.evals = new Evals(options, this.tickets);
		this.assignments = new Assignments(options, this.tickets);
		this.intake = new Intake(options, this.tickets);
	}

	// ------------------------------------------------------------- sources

	/** 001: one Trigger, stored once, fanned out to its Threads' Tickets, queued for Eval unless a Ticket owns it. */
	receive(trigger: Trigger): ReceiveResult {
		return this.store.tx("receive", () => this.intake.receive(trigger), { triggerId: trigger.id });
	}

	/** 003: a Ticket follows a Thread a Source named, such as its own pull request. */
	bindThread(ticketId: TicketId, thread: ThreadKey, own: boolean): void {
		this.store.tx("bindThread", () => this.tickets.bind(ticketId, thread, own), { ticketId, thread });
	}

	/** 003: a Thread closed; the Tickets that follow it may be done. */
	threadClosed(thread: ThreadKey, outcome: "merged" | "closed", at: Ms): void {
		this.store.tx("threadClosed", () => this.tickets.threadClosed(thread, outcome, at), { thread, outcome });
	}

	// -------------------------------------------------------- router session

	candidate(triggerId: TriggerId): Candidate | undefined {
		return this.evals.candidate(triggerId);
	}

	/** 002: the Eval's deadline counts from the moment its candidate reached the router session. */
	candidateDelivered(evalId: EvalId): void {
		this.store.tx("candidateDelivered", () => this.evals.delivered(evalId), { evalId });
	}

	decide(triggerId: TriggerId, outcome: DecisionKind, basis?: string, scope?: string): DecisionId {
		return this.store.tx("decide", () => this.evals.decide(triggerId, outcome, basis, scope), { triggerId, outcome });
	}

	/** 002: a message the router session routes to an existing Ticket, whose worker then decides it. */
	attach(ticketId: TicketId, triggerId: TriggerId, note?: string): void {
		this.store.tx("attach", () => {
			const ticket = this.require(ticketId);
			const trigger = this.requireTrigger(triggerId);
			if (ticket.handedBack?.includes(triggerId)) throw new UserError("handedBackHere");
			if (!liveTicket(ticket) && (!this.mandateHolds(ticket) || ticket.stoppedAt !== undefined)) {
				throw new UserError(ticket.stoppedAt === undefined ? "mandateRevoked" : "ticketStopped");
			}
			this.evals.withdraw(trigger, ticketId);
			this.tickets.attach(ticket, trigger, note);
			this.tickets.resume(ticket);
		}, { ticketId, triggerId });
	}

	requestStatus(ticketId: TicketId): boolean {
		return this.store.tx("requestStatus", () => this.tickets.requestStatus(ticketId), { ticketId });
	}

	note(ticketId: TicketId, text: string): void {
		this.store.tx("note", () => this.tickets.note(ticketId, text), { ticketId });
	}

	reply(request: ReplyRequest): void {
		this.store.tx("reply", () => this.replies.reply(request), { purpose: request.purpose, ticketId: request.ticketId });
	}

	// ---------------------------------------------------------------- people

	stopTicket(ticketId: TicketId, reason?: string): void {
		this.store.tx("stopTicket", () => this.tickets.stop(ticketId, reason), { ticketId });
	}

	retryTicket(ticketId: TicketId): void {
		this.store.tx("retryTicket", () => this.tickets.retry(ticketId), { ticketId });
	}

	reevaluate(triggerId: TriggerId): void {
		this.store.tx("reevaluate", () => this.evals.reevaluate(triggerId), { triggerId });
	}

	unsubscribe(thread: ThreadKey): void {
		this.store.tx("unsubscribe", () => this.tickets.dropSubscriptions(thread), { thread });
	}

	dismiss(decisionId: string): void {
		this.store.tx("dismiss", () => this.evals.dismiss(decisionId), { decisionId });
	}

	/** 003: a person's answer lifts the question and reaches the worker as an Input. */
	answerAttention(ticketId: TicketId, answer: string): void {
		this.store.tx("answerAttention", () => {
			const ticket = this.require(ticketId);
			const attention = ticket.attention;
			if (attention === undefined) throw new UserError("notAttention");
			const answeredAt = this.now();
			const report = ticket.reports.findLast((item) => item.attention?.at === attention.at);
			if (report?.attention !== undefined) {
				report.attention.answeredAt = answeredAt;
				report.attention.answer = answer;
			}
			delete ticket.attention;
			ticket.updatedAt = answeredAt;
			this.tickets.addInput(ticket, {
				id: `in-${ticketId}-answer-${answeredAt}`,
				ticketId,
				kind: "note",
				text: `A person answered: ${answer}`,
				at: answeredAt,
			});
		}, { ticketId });
	}

	/** 003: a pause stops new Evals, Eval timeouts and resume; a running turn is not interrupted. */
	pause(): void {
		this.store.tx("pause", () => {
			if (this.state.pausedAt !== undefined) return;
			this.state.pausedAt = this.now();
		});
	}

	/** 003: resuming moves every deadline later by the pause's length. */
	resume(): void {
		this.store.tx("resume", () => {
			const pausedAt = this.state.pausedAt;
			if (pausedAt === undefined) return;
			const length = this.now() - pausedAt;
			delete this.state.pausedAt;
			for (const batch of Object.values(this.state.evals)) {
				if (batch.deadline !== undefined) batch.deadline += length;
			}
		});
	}

	// -------------------------------------------------------------- settings

	/** 002: each live Ticket the change bears on hears how; Evals in progress start again under the new version. */
	policyChanged(from: Policy, to: Policy): void {
		this.store.tx("policyChanged", () => {
			for (const ticket of Object.values(this.state.tickets)) {
				if (!liveTicket(ticket)) continue;
				const codes = this.options.policy.effectsOf(from, to, ticket);
				if (codes.length === 0) continue;
				this.tickets.noticePolicy(ticket, from, to, codes);
			}
			this.evals.policyChanged();
			this.emit({ type: "policy.changed", at: this.now(), from: from.version, to: to.version });
		}, { from: from.version, to: to.version });
	}

	// -------------------------------------------------------------- executor

	assignmentStarted(ticketId: TicketId, assignmentId: AssignmentId): void {
		this.store.tx("assignmentStarted", () => this.assignments.started(ticketId, assignmentId), { ticketId, assignmentId });
	}

	inputsDelivered(ticketId: TicketId, assignmentId: AssignmentId, inputIds: InputId[]): void {
		this.store.tx("inputsDelivered", () => this.assignments.delivered(ticketId, assignmentId, inputIds), {
			ticketId,
			assignmentId,
			inputs: inputIds.length,
		});
	}

	inputsRead(ticketId: TicketId, inputIds: InputId[]): void {
		this.store.tx("inputsRead", () => this.assignments.read(ticketId, inputIds), { ticketId, inputs: inputIds.length });
	}

	turnEnded(ticketId: TicketId, assignmentId: AssignmentId): void {
		this.store.tx("turnEnded", () => this.assignments.turnEnded(ticketId, assignmentId), { ticketId, assignmentId });
	}

	deliveryFailed(ticketId: TicketId, assignmentId: AssignmentId, error: string): void {
		this.store.tx("deliveryFailed", () => this.assignments.deliveryFailed(ticketId, assignmentId, error), {
			ticketId,
			assignmentId,
		});
	}

	report(ticketId: TicketId, assignmentId: AssignmentId, report: ReportInput): void {
		this.store.tx("report", () => this.assignments.report(ticketId, assignmentId, report), {
			ticketId,
			assignmentId,
			kind: report.kind,
		});
	}

	markUnrelated(ticketId: TicketId, thread: ThreadKey, reason: string): void {
		this.store.tx("markUnrelated", () => this.tickets.markUnrelated(ticketId, thread, reason), { ticketId, thread });
	}

	followForContext(ticketId: TicketId, thread: ThreadKey): void {
		this.store.tx("followForContext", () => this.tickets.followForContext(ticketId, thread), { ticketId, thread });
	}

	handback(ticketId: TicketId, triggerId: TriggerId, reason: string): boolean {
		return this.store.tx("handback", () => this.tickets.handback(ticketId, triggerId, reason), { ticketId, triggerId });
	}

	assignmentInterrupted(ticketId: TicketId, assignmentId: AssignmentId): void {
		this.store.tx("assignmentInterrupted", () => this.assignments.interrupted(ticketId, assignmentId), {
			ticketId,
			assignmentId,
		});
	}

	// ------------------------------------------------------------------ pass

	/**
	 * 002/003: the pass. Expire the Evals past their deadline, resume the ended
	 * Tickets a person's message reached while paused, and start the batches that
	 * wait — one transaction per Eval or Ticket it changes.
	 */
	evaluateDue(): void {
		this.expireDue();
		if (this.paused()) return;
		this.resumePending();
		this.startQueued();
	}

	private expireDue(): void {
		const due = Object.values(this.state.threads).flatMap((thread) => {
			const batch = thread.runningEvalId === undefined ? undefined : this.state.evals[thread.runningEvalId];
			if (batch?.status !== "running" || batch.deadline === undefined) return [];
			return this.now() >= batch.deadline ? [thread.key] : [];
		});
		for (const thread of due) this.store.tx("evalDue", () => this.evals.due(thread), { thread });
	}

	private resumePending(): void {
		const waiting = Object.values(this.state.tickets).filter((ticket) => ticket.resumePending === true);
		for (const ticket of waiting) this.store.tx("resumeTicket", () => this.tickets.resume(ticket), { ticketId: ticket.id });
	}

	private startQueued(): void {
		const ready = Object.values(this.state.threads).flatMap((thread: ThreadRecord) => {
			if (thread.runningEvalId !== undefined) return [];
			const batch = this.queuedEval(thread.key);
			return batch === undefined ? [] : [thread.key];
		});
		for (const thread of ready) this.store.tx("startEval", () => this.evals.start(thread), { thread });
	}

	// ----------------------------------------------------------- role views

	forSources(): EngineForSources {
		return this;
	}

	forMainSession(): EngineForMainSession {
		return this;
	}

	forPeople(): EngineForPeople {
		return this;
	}

	forSettings(): EngineForSettings {
		return this;
	}

	forExecutor(): EngineForExecutor {
		return this;
	}
}

/** Build the Engine over a store, the live Policy and the effect queue. */
export function createEngine(options: EngineOptions): Engine {
	return new DomainEngine(options);
}
