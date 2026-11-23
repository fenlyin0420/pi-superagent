/**
 * Domain types. This file is the shared vocabulary of every module: it holds
 * types and nothing else. The rules live in `stage.ts`, `engine.ts` and its
 * parts.
 *
 * Terms follow `~/projects/dsh-superagent/docs/001-domain.md`.
 */

export type Ms = number;

export type TriggerId = string;
export type ThreadKey = string;
export type EvalId = string;
export type DecisionId = string;
export type TicketId = string;
export type AssignmentId = string;
export type InputId = string;
export type SourceId = string;

// ---------------------------------------------------------------- source side

export interface Actor {
	/** The actor's identifier on this source, such as a GitHub login. */
	id: string;
	bot: boolean;
	/** Display name as the source gives it; never used for authorization. */
	name?: string;
}

/** Where a reply goes: a GitHub conversation and, for review threads, a comment. */
export interface ChannelAddress {
	/** Conversation the write belongs to, e.g. `issue:owner/repo#12`. */
	conversation: string;
	/** Discriminator for the write side, e.g. `review-thread:<id>`. */
	ref?: string;
}

/**
 * One immutable event from a Source. Accepting the same `(source, externalId)`
 * twice stores one Trigger; that pair is the idempotence key.
 */
export interface Trigger {
	id: TriggerId;
	source: SourceId;
	/** Source-owned kind, e.g. `issue_comment`, `ci`, `manual`. */
	kind: string;
	externalId: string;
	at: Ms;
	actor: Actor;
	/** Every thread the Trigger belongs to, the primary one first. */
	threads: ThreadKey[];
	/** Threads related through this Trigger; adds context, never routes. */
	correlations: ThreadKey[];
	channel: ChannelAddress;
	/** Rendered, bounded text an agent can read directly. */
	text: string;
	/** Source payload, for reads that need more than `text`. */
	payload?: unknown;
	/** Set when the Source dropped the event before the domain saw it. */
	filtered?: Filtered;
}

export interface Filtered {
	code: string;
	values?: Record<string, string>;
}

/** A Trigger's disposition: filtered, evaluated or fanned out. */
export interface Disposition {
	triggerId: TriggerId;
	status: "filtered" | "evaluated" | "fanned-out";
	at: Ms;
	/** Set when the Trigger went to a Ticket instead of an Eval. */
	ticketId?: TicketId;
	evalId?: EvalId;
}

export interface ThreadRecord {
	key: ThreadKey;
	source: SourceId;
	/** Trigger order, oldest first. Bounded: only ids are kept beyond the tail. */
	triggerIds: TriggerId[];
	correlations: Record<ThreadKey, true>;
	subscriptions: Subscription[];
	/** The Eval holding this Thread's batch, at most one at a time. */
	runningEvalId?: EvalId;
	decisionIds: DecisionId[];
	closed?: ThreadClose;
	/** Set when a Source made a Ticket follow the Thread. */
	watchedUntil?: Ms;
}

export interface ThreadClose {
	at: Ms;
	outcome: "merged" | "closed";
}

/** A Ticket's relation to a Thread. Held by the Thread. */
export interface Subscription {
	ticketId: TicketId;
	/**
	 * - `origin`: the Thread the Ticket started on
	 * - `own`: a Thread the Ticket opened, such as its pull request
	 * - `attached`: a human routed this Trigger to the Ticket
	 * - `context`: followed for context only: no authority, no resume
	 */
	kind: "origin" | "own" | "attached" | "context";
	at: Ms;
	/** Set when the Ticket's Executor dropped this Subscription as unrelated. */
	dropped?: { at: Ms; reason: string };
}

// ------------------------------------------------------------------ policy

export type AcceptMode = "explicit" | "inferred" | "off";

export interface PolicyRule {
	id: string;
	/** Bounded natural-language rule the assessment reads. */
	text: string;
	/** What an accept under this rule grants. */
	scope: string;
	strength: Strength;
}

export interface SourcePolicy {
	enabled: boolean;
	/** `owner/name` the Source watches. */
	repository: string;
	/** Identities that may originate work through this Source. */
	allowedActors: string[];
	/** Identities treated as bots even when GitHub says otherwise. */
	botActors: string[];
	/** Watch every new issue/PR/comment in the repository, not only mentions. */
	watchAll: boolean;
	/** Poll interval in ms. */
	pollMs: number;
}

export interface Policy {
	version: number;
	acceptMode: AcceptMode;
	rules: PolicyRule[];
	sources: Record<SourceId, SourcePolicy>;
	updatedAt: Ms;
}

// -------------------------------------------------------------------- eval

export type Strength = "explicit" | "inferred";

export type DecisionKind = "accept" | "stop" | "ignore" | "unavailable";

/** Why a Decision was made. Codes render through `reason.<code>` in the panel. */
export interface Reason {
	code: string;
	values?: Record<string, string>;
	/** Set when the reason concerns one Trigger of a batch. */
	triggerId?: TriggerId;
}

export interface Eval {
	id: EvalId;
	thread: ThreadKey;
	source: SourceId;
	triggerIds: TriggerId[];
	status: "queued" | "running" | "done";
	queuedAt: Ms;
	startedAt?: Ms;
	/** Counts from the moment the candidate reached the router session. */
	deadline?: Ms;
	candidateDeliveredAt?: Ms;
	requeues: number;
	decisionId?: DecisionId;
	/** The admissible Trigger that gave the batch its strength. */
	primaryTriggerId?: TriggerId;
	strategy?: Strength;
	basis?: string;
}

export interface Candidate {
	evalId: EvalId;
	thread: ThreadKey;
	source: SourceId;
	triggerIds: TriggerId[];
	strategy: Strength;
	basis: string;
	/** Rule ids the assessment matched. */
	matchedRules: string[];
	reason: Reason[];
	/** The tickets already on the Thread, ended ones included. */
	tickets: Array<{ id: TicketId; state: string; text: string }>;
}

export interface Decision {
	id: DecisionId;
	source: SourceId;
	thread: ThreadKey;
	/** The Trigger an explicit request names; the batch's primary otherwise. */
	triggerId: TriggerId;
	triggerIds: TriggerId[];
	kind: DecisionKind;
	strength: Strength;
	reasons: Reason[];
	at: Ms;
	by: "assessment" | "request" | "person" | "policy";
	ticketId?: TicketId;
	/** Set when an `unavailable` Decision's problem has been dismissed. */
	dismissedAt?: Ms;
}

// ------------------------------------------------------------------ ticket

/** What an accept grants. Immutable; wider scope means a new Ticket. */
export interface Mandate {
	policyVersion: number;
	/** Free text: the work the Mandate allows. */
	scope: string;
	strength: Strength;
	matchedRules: string[];
	/** The requester's identity on that source. */
	requester: Actor;
	/** How the Source received the Trigger, e.g. `issue_comment`. */
	receivedAs: string;
	/** The admissible Trigger and its batch. */
	triggerId: TriggerId;
	triggerIds: TriggerId[];
}

export type TicketEndOutcome =
	| "completed"
	| "merged"
	| "closed"
	| "stopped"
	| "dropped"
	| "failed";

export interface TicketEnd {
	at: Ms;
	by: "executor" | "person" | "policy";
	reason: string;
	outcome: TicketEndOutcome;
}

export interface FollowedThread {
	thread: ThreadKey;
	own: boolean;
	closed?: ThreadClose;
}

export interface TicketExecution {
	/** Short name; also the directory name under the execution root. */
	name: string;
	directory: string;
	assignmentId?: AssignmentId;
}

export interface DeliveryFailure {
	error: string;
	at: Ms;
}

export interface Input {
	id: InputId;
	ticketId: TicketId;
	kind: "trigger" | "policy" | "resume" | "note" | "recovery" | "status";
	text: string;
	triggerId?: TriggerId;
	at: Ms;
	/** Set when the Input reached the Assignment's worker session's stdin/prompt. */
	deliveredAt?: Ms;
	assignmentId?: AssignmentId;
	/** Set when the worker session took it into history. */
	readAt?: Ms;
}

export interface Attention {
	question: string;
	options?: string[];
	at: Ms;
	assignmentId?: AssignmentId;
	answeredAt?: Ms;
	answer?: string;
}

export interface Report {
	at: Ms;
	kind: ReportKind;
	text: string;
	assignmentId?: AssignmentId;
	/** Set when the report was a question for a person. */
	attention?: Attention;
}

export type ReportKind =
	| "progress"
	| "waiting"
	| "ready"
	| "blocked"
	| "failed"
	| "dropped";

export interface Ticket {
	id: TicketId;
	name: string;
	source: SourceId;
	/** The Thread the Ticket started on. */
	thread: ThreadKey;
	mandate: Mandate;
	origin: { triggerId: TriggerId; triggerIds: TriggerId[] };
	execution: TicketExecution;
	/** Threads a Source made the Ticket follow, its own pull requests first. */
	follows: FollowedThread[];
	subscriptions: ThreadKey[];
	inputs: Input[];
	reports: Report[];
	assignmentIds: AssignmentId[];
	attention?: Attention;
	delivery?: DeliveryFailure;
	notes: Array<{ at: Ms; text: string; by: "router" | "person" }>;
	createdAt: Ms;
	updatedAt: Ms;
	ended?: TicketEnd;
	/** Set when a person stopped the Ticket: it never resumes. */
	stoppedAt?: Ms;
	/** Set when processing was paused and a person's message has to resume it. */
	resumePending?: boolean;
	/** Handed-back Triggers, so a Ticket hands each back once. */
	handedBack?: TriggerId[];
}

export interface Assignment {
	id: AssignmentId;
	ticketId: TicketId;
	state: "pending" | "running" | "ended";
	sessionId: string;
	directory: string;
	/** Set once the prepare command succeeded; preparation runs once. */
	preparedAt?: Ms;
	startedAt?: Ms;
	endedAt?: Ms;
	endReason?: string;
	/** The worker's last words, for recovery notes and killed-job reports. */
	lastWords?: string;
}

// ------------------------------------------------------------------- state

export interface SourceState {
	id: SourceId;
	/** Source-owned read position, e.g. `{ notifications: 1699…, issue: {...} }`. */
	readPosition: Record<string, number | string>;
	/** The agent's own identity on this source. */
	self?: Actor;
	lastPollAt?: Ms;
	lastError?: { at: Ms; message: string };
}

export interface State {
	version: 1;
	sources: Record<SourceId, SourceState>;
	triggers: Record<TriggerId, Trigger>;
	dispositions: Record<TriggerId, Disposition>;
	threads: Record<ThreadKey, ThreadRecord>;
	evals: Record<EvalId, Eval>;
	decisions: Record<DecisionId, Decision>;
	tickets: Record<TicketId, Ticket>;
	assignments: Record<AssignmentId, Assignment>;
	policy: Policy;
	/** Sequence counters for readable ids. */
	seq: { trigger: number; eval: number; decision: number; ticket: number; assignment: number; input: number };
	/** Problems the router session shows once, e.g. a Source that failed thrice. */
	problems: Array<{ at: Ms; code: string; message: string; count: number; dismissedAt?: Ms }>;
	pausedAt?: Ms;
}

// ------------------------------------------------------------------- views

export type StageKind = "person" | "working" | "idle";

export type StageCode =
	| "delivery"
	| "answer"
	| "review"
	| "blocked"
	| "failed"
	| "queued"
	| "idle"
	| "working";

export interface Stage {
	kind: StageKind;
	code: StageCode;
}

export interface TicketRow {
	id: TicketId;
	name: string;
	stage: Stage;
	label: string;
	source: SourceId;
	thread: ThreadKey;
	scope: string;
	reports: number;
	pulls: string[];
	updatedAt: Ms;
}

export interface Overview {
	policyVersion: number;
	paused: boolean;
	host: { pid: number; startedAt: Ms } | null;
	tickets: TicketRow[];
	triggers: Array<{ id: TriggerId; at: Ms; kind: string; text: string; status: string }>;
	problems: State["problems"];
	sources: Array<{ id: SourceId; lastPollAt?: Ms; lastError?: { at: Ms; message: string } }>;
}
