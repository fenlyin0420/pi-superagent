/**
 * What the five parts share: the options the Engine is built with, the base class
 * they extend, and the predicates more than one part reads. Every part method
 * runs inside the transaction the Engine opens for its command.
 *
 * The rules cite `~/projects/dsh-superagent/docs`: `001-domain.md` for the
 * concepts, `002-authorization.md` for who may start work, `003-execution.md`
 * for what a Ticket does while it runs.
 */
import type {
	Assignment,
	AssignmentId,
	Decision,
	DecisionKind,
	Eval,
	EvalId,
	Input,
	Ms,
	Policy,
	Report,
	SourceId,
	State,
	ThreadClose,
	ThreadKey,
	ThreadRecord,
	Ticket,
	TicketEndOutcome,
	TicketId,
	Trigger,
	TriggerId,
} from "./model.js";
import type { Effect, Effects, PolicyPort, Store } from "./ports.js";

export interface EngineOptions {
	store: Store;
	policy: PolicyPort;
	effects: Effects;
	/** Wall clock; tests inject a fixed one. */
	now?: () => Ms;
	/** Domain events, for the notices the host session shows. */
	emit?: (event: DomainEvent) => void;
	/** How long a candidate may wait for a Decision once it reached the router session. */
	evalTimeoutMs?: number;
	/** The directory a Ticket works in, given its short name; the runtime maps it under the state dir. */
	directoryFor?: (name: string) => string;
	/** The acknowledgement an accept posts where the request was written. */
	acknowledgement?: (ticket: Ticket) => string;
}

export const DEFAULT_EVAL_TIMEOUT_MS = 120_000;
export const DEFAULT_ACKNOWLEDGEMENT = "Thanks — picked this up and will report back here.";

/** What changed, for the notices the host session and the panel render. */
export type DomainEvent =
	| { type: "trigger.received"; at: Ms; triggerId: TriggerId; threads: ThreadKey[] }
	| { type: "trigger.requeued"; at: Ms; triggerId: TriggerId }
	| { type: "trigger.handbacked"; at: Ms; triggerId: TriggerId; ticketId: TicketId; reason: string }
	| { type: "trigger.routed"; at: Ms; triggerId: TriggerId; ticketId: TicketId }
	| { type: "eval.started"; at: Ms; evalId: EvalId; thread: ThreadKey; triggerIds: TriggerId[]; strength: string }
	| { type: "decision.recorded"; at: Ms; decisionId: string; kind: DecisionKind; thread: ThreadKey }
	| { type: "ticket.created"; at: Ms; ticketId: TicketId; decisionId: string; strength: string }
	| { type: "ticket.resumed"; at: Ms; ticketId: TicketId; triggerId: TriggerId }
	| { type: "ticket.ended"; at: Ms; ticketId: TicketId; by: string; outcome: TicketEndOutcome; reason: string }
	| { type: "assignment.started"; at: Ms; ticketId: TicketId; assignmentId: AssignmentId }
	| { type: "assignment.ended"; at: Ms; ticketId: TicketId; assignmentId: AssignmentId; reason: string }
	| { type: "thread.subscribed"; at: Ms; thread: ThreadKey; ticketId: TicketId }
	| { type: "thread.unsubscribed"; at: Ms; thread: ThreadKey; ticketId: TicketId; by: string }
	| { type: "policy.changed"; at: Ms; from: number; to: number };

/** User-facing error messages; the panel words `error.<code>` in its locale. */
export const USER_ERRORS = {
	unknownTicket: "Unknown ticket",
	unknownTrigger: "Unknown trigger",
	unknownAssignment: "Unknown assignment",
	unknownDecision: "Unknown decision",
	unknownThread: "Unknown thread",
	ticketEnded: "The ticket has ended",
	assignmentEnded: "The assignment has ended; a newer one owns this ticket",
	evalFinished: "The eval has finished; decide the trigger's current eval",
	notAdmissible: "The trigger is not admissible: {reason}",
	noRule: "A proactive accept needs at least one matched rule",
	notRetryable: "Retry needs a failed input delivery, or a blocked or failed report a person has not answered yet",
	ticketStopped: "A person stopped this ticket; new work needs a new accept",
	mandateRevoked: "The policy no longer holds this ticket's mandate",
	notReached: "The trigger did not reach this ticket",
	handedBack: "This ticket handed that trigger back already",
	handedBackHere: "This ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it",
	sourceThread: "This is the thread the ticket started on; it stays subscribed",
	followedThread: "This thread is the ticket's own, such as its pull request's; it stays subscribed",
	notFollowing: "This ticket does not follow that thread",
	ackEnded: "The ticket ended; do not acknowledge historical requests",
	ackNotPerson: "Use the original person's message, not a bot's or the agent's",
	answerNotAsked: "An answer goes to a question a person asked this ticket",
	noAnswer: "The worker has not answered yet; wait for its report",
	notReady: "The ticket has no ready result to send",
	notAttention: "The ticket has no open question for a person",
	notQuestion: "A question for a person is never also a ready result",
	questionWithResult: "A question for a person cannot also be a ready result",
} as const satisfies Record<string, string>;

export type UserErrorCode = keyof typeof USER_ERRORS;

/** Thrown by the Engine and its parts for a request that cannot be honoured. */
export class UserError extends Error {
	readonly code: UserErrorCode;
	readonly values: Record<string, string>;

	constructor(code: UserErrorCode, values: Record<string, string> = {}) {
		super(USER_ERRORS[code].replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match));
		this.name = "UserError";
		this.code = code;
		this.values = values;
	}
}

// ------------------------------------------------------------- predicates

/** 001: a ticket is open while it has no end. */
export function liveTicket(ticket: Pick<Ticket, "ended">): boolean {
	return ticket.ended === undefined;
}

/** 002: only a person's stop withdraws a Mandate, so a stopped ticket receives nothing more. */
export function stoppedTicket(ticket: Pick<Ticket, "stoppedAt" | "ended">): boolean {
	return ticket.stoppedAt !== undefined || ticket.ended?.by === "person";
}

/** What the ticket last said. */
export function latestReport(ticket: Pick<Ticket, "reports">): Report | undefined {
	return ticket.reports.at(-1);
}

export function latestAssignment(state: State, ticket: Pick<Ticket, "assignmentIds">): Assignment | undefined {
	const id = ticket.assignmentIds.at(-1);
	return id === undefined ? undefined : state.assignments[id];
}

export function runningAssignment(state: State, ticket: Pick<Ticket, "assignmentIds">): Assignment | undefined {
	const latest = latestAssignment(state, ticket);
	return latest?.state === "running" ? latest : undefined;
}

/** The Inputs the worker has not received yet. */
export function undeliveredInputs(ticket: Pick<Ticket, "inputs">): Input[] {
	return ticket.inputs.filter((input) => input.deliveredAt === undefined);
}

/** 001: a person wrote the message behind this Input; a bot's or the agent's own does not count. */
export function personInput(state: State, input: Input): boolean {
	if (input.kind === "resume") return true;
	if (input.kind !== "trigger" || input.triggerId === undefined) return false;
	const trigger = state.triggers[input.triggerId];
	return trigger !== undefined && !trigger.actor.bot;
}

/**
 * 003: an Assignment that reported `blocked` or `failed` takes no automatic
 * Input until a person's message reaches the ticket.
 */
export function waitsForPerson(state: State, ticket: Ticket): boolean {
	const report = latestReport(ticket);
	if (report === undefined || (report.kind !== "blocked" && report.kind !== "failed")) return false;
	return !ticket.inputs.some((input) => personInput(state, input) && input.at > report.at);
}

/** 001: a Decision settled what a message asked for; a stop and an unavailable one did not. */
export function settled(decision: Pick<Decision, "kind">): boolean {
	return decision.kind !== "stop" && decision.kind !== "unavailable";
}

/**
 * 003: a ticket is done with the Threads it follows once no Thread it opened is
 * still open or, having opened none, once every Thread it follows closed; the
 * outcome is the latest of those closes.
 */
export function followsDone(ticket: Pick<Ticket, "follows">): ThreadClose | undefined {
	const own = ticket.follows.filter((follow) => follow.own);
	const counted = own.length > 0 ? own : ticket.follows;
	if (counted.length === 0) return undefined;
	let last: ThreadClose | undefined;
	for (const follow of counted) {
		if (follow.closed === undefined) return undefined;
		if (last === undefined || follow.closed.at >= last.at) last = follow.closed;
	}
	return last;
}

export type SeqKind = keyof State["seq"];

/** The next readable number of an id kind, taken from the state's counters. */
export function nextSeq(state: State, kind: SeqKind): number {
	const next = state.seq[kind] + 1;
	state.seq[kind] = next;
	return next;
}

// ------------------------------------------------------------------ part

export abstract class EnginePart {
	protected readonly store: Store;

	constructor(protected readonly options: EngineOptions) {
		this.store = options.store;
	}

	protected get state(): State {
		return this.options.store.state;
	}

	protected now(): Ms {
		return this.options.now?.() ?? Date.now();
	}

	protected policy(): Policy {
		return this.options.policy.current();
	}

	/** 003: processing is paused, so no Eval starts or expires and no Ticket resumes. */
	protected paused(): boolean {
		return this.state.pausedAt !== undefined;
	}

	protected effect(effect: Effect): void {
		this.options.effects.enqueue(effect);
	}

	protected emit(event: DomainEvent): void {
		this.options.emit?.(event);
	}

	protected require(ticketId: TicketId): Ticket {
		const ticket = this.state.tickets[ticketId];
		if (ticket === undefined) throw new UserError("unknownTicket");
		return ticket;
	}

	protected requireTrigger(triggerId: TriggerId): Trigger {
		const trigger = this.state.triggers[triggerId];
		if (trigger === undefined) throw new UserError("unknownTrigger");
		return trigger;
	}

	protected requireAssignment(ticket: Ticket, assignmentId: AssignmentId): Assignment {
		const assignment = this.state.assignments[assignmentId];
		if (assignment === undefined || assignment.ticketId !== ticket.id) throw new UserError("unknownAssignment");
		return assignment;
	}

	protected thread(key: ThreadKey, source: SourceId): ThreadRecord {
		const existing = this.state.threads[key];
		if (existing !== undefined) return existing;
		const created: ThreadRecord = {
			key,
			source,
			triggerIds: [],
			correlations: {},
			subscriptions: [],
			decisionIds: [],
		};
		this.state.threads[key] = created;
		return created;
	}

	/** The batch of Triggers waiting for the Thread's next Eval, held as one queued Eval. */
	protected queuedEval(thread: ThreadKey): Eval | undefined {
		let found: Eval | undefined;
		for (const evalRecord of Object.values(this.state.evals)) {
			if (evalRecord.thread !== thread || evalRecord.status !== "queued") continue;
			if (found === undefined || evalRecord.queuedAt >= found.queuedAt) found = evalRecord;
		}
		return found;
	}

	/** The Eval, running or queued, that holds a Trigger. */
	protected evalHolding(triggerId: TriggerId): Eval | undefined {
		for (const evalRecord of Object.values(this.state.evals)) {
			if (evalRecord.status !== "done" && evalRecord.triggerIds.includes(triggerId)) return evalRecord;
		}
		return undefined;
	}

	protected enqueueTrigger(thread: ThreadRecord, triggerId: TriggerId): Eval {
		const batch = this.queuedEval(thread.key) ?? this.openBatch(thread);
		if (!batch.triggerIds.includes(triggerId)) batch.triggerIds.push(triggerId);
		const disposition = this.state.dispositions[triggerId];
		this.state.dispositions[triggerId] = {
			triggerId,
			status: disposition?.status ?? "evaluated",
			at: this.now(),
			...(disposition?.ticketId === undefined ? {} : { ticketId: disposition.ticketId }),
			evalId: batch.id,
		};
		return batch;
	}

	private openBatch(thread: ThreadRecord): Eval {
		const id = `eval-${nextSeq(this.state, "eval")}`;
		const created: Eval = {
			id,
			thread: thread.key,
			source: thread.source,
			triggerIds: [],
			status: "queued",
			queuedAt: this.now(),
			requeues: 0,
		};
		this.state.evals[id] = created;
		return created;
	}

	/** 002: the Mandate still holds when its origin Trigger passes the gate again at that strength. */
	protected mandateHolds(ticket: Ticket): boolean {
		const trigger = this.state.triggers[ticket.mandate.triggerId];
		if (trigger === undefined) return false;
		const gate = this.options.policy.gate(trigger);
		if (!gate.admissible) return false;
		return gate.strength === "explicit" || ticket.mandate.strength === "inferred";
	}
}
