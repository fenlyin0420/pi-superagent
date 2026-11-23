/**
 * The contract between modules. Adapters implement these ports; the Engine
 * consumes them. Nothing here knows about Pi, `gh` or the terminal.
 */
import type {
	Actor,
	Assignment,
	AssignmentId,
	Candidate,
	ChannelAddress,
	DecisionId,
	DecisionKind,
	EvalId,
	Input,
	InputId,
	Ms,
	Policy,
	SourceId,
	State,
	Strength,
	ThreadKey,
	Ticket,
	TicketId,
	Trigger,
	TriggerId,
} from "./model.js";

// ------------------------------------------------------------------- store

export interface JournalEntry {
	at: Ms;
	/** Domain command name, e.g. `createTicket`. */
	cmd: string;
	/** Bounded, structural detail: ids and codes only, never message bodies. */
	detail?: Record<string, unknown>;
}

export interface Store {
	/**
	 * The live aggregate graph. Read freely; write only inside `tx`.
	 */
	readonly state: State;
	/**
	 * Run one synchronous mutation and persist it. The snapshot is written
	 * atomically and the journal receives one entry. If `mutate` throws, the
	 * in-memory state rolls back to the last committed snapshot.
	 */
	tx<T>(cmd: string, mutate: (state: State) => T, detail?: Record<string, unknown>): T;
	/** Persist without a domain command, e.g. after a Source moves its cursor. */
	flush(): void;
}

// ----------------------------------------------------------------- effects

/** External work, queued inside the transaction that decided it. */
export type Effect =
	| { kind: "prepare"; ticketId: TicketId; assignmentId: AssignmentId }
	| { kind: "launch"; ticketId: TicketId; assignmentId: AssignmentId }
	| { kind: "deliver"; ticketId: TicketId; assignmentId: AssignmentId; inputIds: InputId[] }
	| { kind: "endAssignment"; ticketId: TicketId; assignmentId: AssignmentId; reason: string }
	| { kind: "requestStatus"; ticketId: TicketId; assignmentId: AssignmentId }
	| { kind: "reply"; message: OutboundMessage }
	| { kind: "relay"; message: RouterMessage };

export interface Effects {
	/** Called inside a transaction; performed after commit, retried on failure. */
	enqueue(effect: Effect): void;
}

export interface OutboundMessage {
	id: string;
	source: SourceId;
	channel: ChannelAddress;
	thread: ThreadKey;
	/** Stable per conversation intent: acknowledgement, answer, result, attention. */
	purpose: "acknowledgement" | "answer" | "result" | "attention" | "notice";
	ticketId?: TicketId;
	body: string;
	at: Ms;
}

/** A message for the router session (the host Pi session). */
export interface RouterMessage {
	id: string;
	/** `candidate` asks for a Decision; the rest are notices. */
	kind: "candidate" | "report" | "followup" | "notice" | "problem";
	at: Ms;
	candidate?: Candidate;
	/** Rendered, bounded text the router reads directly. */
	text: string;
	/** Tickets the message refers to, for tools and the panel. */
	ticketIds?: TicketId[];
	triggerId?: TriggerId;
}

// ------------------------------------------------------------------ policy

export interface PolicyPort {
	current(): Policy;
	/** Effects a change has on a live Ticket; empty when it bears on nothing. */
	effectsOf(from: Policy, to: Policy, ticket: Ticket): string[];
	/** Strength and matched rules of a Trigger under the current Policy. */
	gate(trigger: Trigger): GateResult;
}

export interface GateResult {
	admissible: boolean;
	strength: Strength;
	/** Set when the Trigger cannot originate work. */
	refusal?: { code: string; values?: Record<string, string> };
	matchedRules: string[];
}

// -------------------------------------------------------------- assessment

export interface AssessmentInput {
	source: SourceId;
	thread: ThreadKey;
	triggers: Trigger[];
	/** Bounded rendered history of the Thread. */
	history: string;
	/** Every Ticket on the Thread, ended ones included. */
	tickets: Ticket[];
	policy: Policy;
	gate: GateResult;
}

/**
 * The model's judgement. Returns a Decision's substance; the Engine records it.
 */
export interface Assessor {
	assess(input: AssessmentInput): Promise<AssessorVerdict>;
}

export interface AssessorVerdict {
	kind: DecisionKind;
	strength: Strength;
	basis: string;
	scope: string;
	matchedRules: string[];
	reasons: Array<{ code: string; values?: Record<string, string> }>;
}

// ------------------------------------------------------------------ executor

export interface LaunchRequest {
	ticket: Ticket;
	assignment: Assignment;
	/** The rendered assignment text: mandate, scope, delivery requirements. */
	brief: string;
}

export interface TurnResult {
	ok: boolean;
	exitCode: number | null;
	/** The worker's last assistant text, for recovery notes. */
	lastWords: string;
	/** True when the failure was a passing one (408/429/5xx, reset, timeout). */
	transient: boolean;
	error?: string;
}

/**
 * The port the Engine calls. Every method is fire-and-forget: the adapter
 * reports back through `ExecutorSink`, never by returning domain state.
 */
export interface Executor {
	/** Run the prepare command once, then `launch` reports `assignmentStarted`. */
	prepare(request: LaunchRequest): void;
	launch(request: LaunchRequest): void;
	deliver(ticket: Ticket, assignment: Assignment, inputs: Input[]): void;
	end(ticket: Ticket, assignment: Assignment, reason: string): Promise<void>;
	requestStatus(ticket: Ticket, assignment: Assignment): void;
	/** Graceful shutdown: stop accepting, end running assignments as `restarted`. */
	shutdown(): Promise<void>;
}

// ------------------------------------------------------------------ sources

/**
 * What a Source instance may do: everything it needs and nothing else.
 */
export interface SourceScope {
	readonly id: SourceId;
	receive(trigger: Trigger): "stored" | "duplicate" | "filtered";
	bindThread(ticketId: TicketId, thread: ThreadKey, own: boolean): void;
	threadClosed(thread: ThreadKey, outcome: "merged" | "closed", at: Ms): void;
	send(message: OutboundMessage): Promise<void>;
	/** The agent's identity on this source, for dropping its own events. */
	self(): Actor | undefined;
	policy(): Policy;
	/** Read position, persisted by the Source after each successful poll. */
	position(key: string): number | string | undefined;
	setPosition(key: string, value: number | string): void;
	problem(code: string, message: string): void;
}

export interface Source {
	readonly id: SourceId;
	start(scope: SourceScope): void;
	stop(): Promise<void>;
	/** Poll now instead of waiting for the interval; the panel asks for this. */
	poll(): Promise<void>;
	status(): { lastPollAt?: Ms; lastError?: { at: Ms; message: string } };
}

// ------------------------------------------------------- engine role views

/** Facts the Executor reports. Past tense: the adapter observed them. */
export interface EngineForExecutor {
	assignmentStarted(ticketId: TicketId, assignmentId: AssignmentId): void;
	inputsDelivered(ticketId: TicketId, assignmentId: AssignmentId, inputIds: InputId[]): void;
	inputsRead(ticketId: TicketId, inputIds: InputId[]): void;
	turnEnded(ticketId: TicketId, assignmentId: AssignmentId): void;
	deliveryFailed(ticketId: TicketId, assignmentId: AssignmentId, error: string): void;
	report(ticketId: TicketId, assignmentId: AssignmentId, report: ReportInput): void;
	markUnrelated(ticketId: TicketId, thread: ThreadKey, reason: string): void;
	followForContext(ticketId: TicketId, thread: ThreadKey): void;
	handback(ticketId: TicketId, triggerId: TriggerId, reason: string): boolean;
	assignmentInterrupted(ticketId: TicketId, assignmentId: AssignmentId): void;
}

export interface ReportInput {
	kind: "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";
	text: string;
	attention?: { question: string; options?: string[] };
}

/** What a Source instance may call. */
export interface EngineForSources {
	receive(trigger: Trigger): "stored" | "duplicate" | "filtered";
	bindThread(ticketId: TicketId, thread: ThreadKey, own: boolean): void;
	threadClosed(thread: ThreadKey, outcome: "merged" | "closed", at: Ms): void;
}

/** What the router session (host Pi session) may call. */
export interface EngineForMainSession {
	candidate(triggerId: TriggerId): Candidate | undefined;
	candidateDelivered(evalId: EvalId): void;
	decide(triggerId: TriggerId, outcome: DecisionKind, basis?: string, scope?: string): DecisionId;
	attach(ticketId: TicketId, triggerId: TriggerId, note?: string): void;
	requestStatus(ticketId: TicketId): boolean;
	note(ticketId: TicketId, text: string): void;
	reply(request: ReplyRequest): void;
}

export interface ReplyRequest {
	source: SourceId;
	thread: ThreadKey;
	channel: ChannelAddress;
	purpose: "acknowledgement" | "answer" | "result" | "attention";
	ticketId?: TicketId;
	body: string;
}

/** What a person may call, from the panel or a command. */
export interface EngineForPeople {
	stopTicket(ticketId: TicketId, reason?: string): void;
	retryTicket(ticketId: TicketId): void;
	reevaluate(triggerId: TriggerId): void;
	unsubscribe(thread: ThreadKey): void;
	dismiss(decisionId: string): void;
	answerAttention(ticketId: TicketId, answer: string): void;
	pause(): void;
	resume(): void;
}

/** What settings may call. */
export interface EngineForSettings {
	policyChanged(from: Policy, to: Policy): void;
}

export interface Engine
	extends EngineForSources,
		EngineForMainSession,
		EngineForPeople,
		EngineForSettings {
	forSources(): EngineForSources;
	forMainSession(): EngineForMainSession;
	forPeople(): EngineForPeople;
	forSettings(): EngineForSettings;
	forExecutor(): EngineForExecutor;
	/** The pass: start due Evals, expire them, resume Tickets waiting on a pause. */
	evaluateDue(): void;
}
