/**
 * In-memory doubles for the ports in `src/core/ports.ts`. The engine's tests use
 * them instead of the snapshot store, the executor and the model.
 */
import type {
	Assignment,
	Input,
	Ms,
	Policy,
	Report,
	State,
	Ticket,
	TicketId,
	Trigger,
} from "../core/model.js";
import type {
	AssessmentInput,
	Assessor,
	AssessorVerdict,
	Effect,
	Effects,
	Executor,
	LaunchRequest,
	Store,
} from "../core/ports.js";
import { createInitialState } from "../infra/store.js";

// ------------------------------------------------------------------- store

/** The `Store` port without a disk: same transaction and rollback rules. */
export class MemoryStore implements Store {
	readonly state: State;
	/** Domain commands in order, as `[cmd, detail]` pairs would be journalled. */
	readonly commands: Array<{ cmd: string; detail?: Record<string, unknown> }> = [];
	private flushes = 0;

	constructor(state: State = createInitialState()) {
		this.state = state;
	}

	get flushCount(): number {
		return this.flushes;
	}

	tx<T>(cmd: string, mutate: (state: State) => T, detail?: Record<string, unknown>): T {
		const snapshot = structuredClone(this.state);
		let result: T;
		try {
			result = mutate(this.state);
		} catch (error) {
			Object.assign(this.state, snapshot);
			throw error;
		}
		this.commands.push(detail === undefined ? { cmd } : { cmd, detail });
		return result;
	}

	flush(): void {
		this.flushes += 1;
	}
}

// ----------------------------------------------------------------- effects

export class RecordingEffects implements Effects {
	readonly effects: Effect[] = [];

	enqueue(effect: Effect): void {
		this.effects.push(effect);
	}

	/** Every effect queued so far, and clear the record. */
	take(): Effect[] {
		return this.effects.splice(0, this.effects.length);
	}

	ofKind<K extends Effect["kind"]>(kind: K): Array<Extract<Effect, { kind: K }>> {
		return this.effects.filter((effect): effect is Extract<Effect, { kind: K }> => effect.kind === kind);
	}

	clear(): void {
		this.effects.length = 0;
	}
}

// -------------------------------------------------------------- assessment

export const IGNORE_VERDICT: AssessorVerdict = {
	kind: "ignore",
	strength: "inferred",
	basis: "",
	scope: "",
	matchedRules: [],
	reasons: [],
};

export function acceptVerdict(scope = "the requested work", matchedRules: string[] = []): AssessorVerdict {
	return { kind: "accept", strength: "explicit", basis: "explicit request", scope, matchedRules, reasons: [] };
}

/** Answers the queued verdicts in order, then `IGNORE_VERDICT`. */
export class FakeAssessor implements Assessor {
	readonly inputs: AssessmentInput[] = [];
	readonly verdicts: AssessorVerdict[] = [];

	constructor(...verdicts: AssessorVerdict[]) {
		this.verdicts.push(...verdicts);
	}

	async assess(input: AssessmentInput): Promise<AssessorVerdict> {
		this.inputs.push(input);
		return this.verdicts.shift() ?? IGNORE_VERDICT;
	}
}

// ---------------------------------------------------------------- executor

export class FakeExecutor implements Executor {
	readonly prepared: LaunchRequest[] = [];
	readonly launched: LaunchRequest[] = [];
	readonly delivered: Array<{ ticket: Ticket; assignment: Assignment; inputs: Input[] }> = [];
	readonly ended: Array<{ ticketId: TicketId; assignmentId: string; reason: string }> = [];
	readonly statusRequests: Array<{ ticketId: TicketId; assignmentId: string }> = [];
	private shutdowns = 0;

	prepare(request: LaunchRequest): void {
		this.prepared.push(request);
	}

	launch(request: LaunchRequest): void {
		this.launched.push(request);
	}

	deliver(ticket: Ticket, assignment: Assignment, inputs: Input[]): void {
		this.delivered.push({ ticket, assignment, inputs });
	}

	async end(ticket: Ticket, assignment: Assignment, reason: string): Promise<void> {
		this.ended.push({ ticketId: ticket.id, assignmentId: assignment.id, reason });
	}

	requestStatus(ticket: Ticket, assignment: Assignment): void {
		this.statusRequests.push({ ticketId: ticket.id, assignmentId: assignment.id });
	}

	async shutdown(): Promise<void> {
		this.shutdowns += 1;
	}

	get shutdownCount(): number {
		return this.shutdowns;
	}

	clear(): void {
		this.prepared.length = 0;
		this.launched.length = 0;
		this.delivered.length = 0;
		this.ended.length = 0;
		this.statusRequests.length = 0;
	}
}

// ----------------------------------------------------------------- fixtures

let counter = 0;

export function makeTrigger(patch: Partial<Trigger> = {}): Trigger {
	counter += 1;
	const id = patch.id ?? `trg-${counter}`;
	return {
		id,
		source: "github",
		kind: "issue_comment",
		externalId: id,
		at: 1_000 + counter,
		actor: { id: "alice", bot: false },
		threads: ["issue:1"],
		correlations: [],
		channel: { conversation: "issue:owner/repo#1" },
		text: "Please fix the flaky upload test.",
		...patch,
	};
}

export function makePolicy(patch: Partial<Policy> = {}): Policy {
	const base = createInitialState().policy;
	return { ...base, ...patch, sources: { ...base.sources, ...patch.sources } };
}

export interface TicketOptions extends Partial<Ticket> {
	id?: TicketId;
	name?: string;
}

export function makeTicket(patch: TicketOptions = {}): Ticket {
	counter += 1;
	const id = patch.id ?? `tkt-${counter}`;
	const at: Ms = patch.createdAt ?? 10_000 + counter;
	return {
		id,
		name: patch.name ?? `ticket-${counter}`,
		source: "github",
		thread: "issue:1",
		mandate: {
			policyVersion: 1,
			scope: "fix the flaky upload test",
			strength: "explicit",
			matchedRules: [],
			requester: { id: "alice", bot: false },
			receivedAs: "issue_comment",
			triggerId: `trg-${counter}`,
			triggerIds: [`trg-${counter}`],
		},
		origin: { triggerId: `trg-${counter}`, triggerIds: [`trg-${counter}`] },
		execution: { name: patch.name ?? `ticket-${counter}`, directory: `/tmp/${id}` },
		follows: [],
		subscriptions: ["issue:1"],
		inputs: [],
		reports: [],
		assignmentIds: [],
		notes: [],
		createdAt: at,
		updatedAt: at,
		...patch,
	};
}

export function makeAssignment(ticket: Ticket, patch: Partial<Assignment> = {}): Assignment {
	counter += 1;
	const id = patch.id ?? `asg-${counter}`;
	return {
		id,
		ticketId: ticket.id,
		state: "running",
		sessionId: `sagent/${ticket.id}`,
		directory: ticket.execution.directory,
		startedAt: ticket.createdAt,
		...patch,
	};
}

export function makeInput(ticket: Ticket, patch: Partial<Input> = {}): Input {
	counter += 1;
	const id = patch.id ?? `inp-${counter}`;
	return {
		id,
		ticketId: ticket.id,
		kind: "trigger",
		text: "Any update?",
		at: ticket.createdAt + 1,
		...patch,
	};
}

export function makeReport(patch: Partial<Report> = {}): Report {
	counter += 1;
	return { at: 20_000 + counter, kind: "progress", text: "Working on it.", ...patch };
}
