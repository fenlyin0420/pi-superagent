/**
 * The durable effect queue (docs/000-design.md "Runtime", "Invariants").
 *
 * The Engine enqueues external work inside the transaction that decided it;
 * this queue appends the row to `<state>/effects.jsonl` before the transaction
 * returns and performs it after the commit. A row that fails is retried after
 * 2s, doubling to 60s; the Queue never throws into a transaction, and every row
 * is resolved again against live state before it runs, so a replayed row for a
 * rolled-back or already-finished command is skipped instead of reapplied.
 *
 * Order: `prepare` runs before `launch`, `launch` before `deliver` for the same
 * Ticket, and rows that share an ordering key run oldest first.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Assignment, Input, Ms, State, Ticket } from "../core/model.js";
import type { Effect, Effects, LaunchRequest, OutboundMessage, RouterMessage } from "../core/ports.js";
import { liveTicket, undeliveredInputs } from "../core/part.js";

export const RETRY_FIRST_MS = 2_000;
export const RETRY_MAX_MS = 60_000;
export const FAILURES_BEFORE_PROBLEM = 3;

/** The adapters a row is handed to. */
export interface EffectTargets {
	prepare(request: LaunchRequest): Promise<void> | void;
	launch(request: LaunchRequest): Promise<void> | void;
	deliver(ticket: Ticket, assignment: Assignment, inputs: Input[]): Promise<void> | void;
	end(ticket: Ticket, assignment: Assignment, reason: string): Promise<void> | void;
	requestStatus(ticket: Ticket, assignment: Assignment): Promise<void> | void;
	reply(message: OutboundMessage): Promise<void> | void;
	relay(message: RouterMessage): Promise<void> | void;
}

/** The Channel writer a `reply` row goes through; `src/app/outbox.ts` implements it. */
export interface Outbox {
	send(message: OutboundMessage): Promise<void> | void;
}

export interface EffectProblem {
	kind: Effect["kind"];
	code: string;
	message: string;
	count: number;
	at: Ms;
}

export interface EffectRow {
	seq: number;
	at: Ms;
	effect: Effect;
	attempts: number;
	due: Ms;
}

export interface EffectQueueOptions {
	file: string;
	/** Live domain state, for resolving a row into what its adapter needs. */
	state: () => State;
	targets: EffectTargets;
	/** The assignment text a launch carries; the Executor may pass its own renderer. */
	brief?: (ticket: Ticket, assignment: Assignment) => string;
	/** Called once a kind has failed this many times in a row. */
	onProblem?: (problem: EffectProblem) => void;
	clock?: () => Ms;
	retryFirstMs?: Ms;
	retryMaxMs?: Ms;
	failuresBeforeProblem?: number;
	/** Rows that may run at once; ordering keys never run twice at once. */
	concurrency?: number;
}

/** Order in which a Ticket's rows must run; anything else is independent. */
const STAGE: Partial<Record<Effect["kind"], number>> = { prepare: 0, launch: 1, deliver: 2 };

export class EffectQueue implements Effects {
	private readonly file: string;
	private readonly stateOf: () => State;
	private readonly targets: EffectTargets;
	private readonly brief: (ticket: Ticket, assignment: Assignment) => string;
	private readonly onProblem?: (problem: EffectProblem) => void;
	private readonly clock: () => Ms;
	private readonly retryFirstMs: Ms;
	private readonly retryMaxMs: Ms;
	private readonly failuresBeforeProblem: number;
	private readonly concurrency: number;
	private rows: EffectRow[] = [];
	private seq = 0;
	private running = new Map<string, Promise<void>>();
	private failures = new Map<Effect["kind"], number>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private started = false;
	private stopped = false;

	constructor(options: EffectQueueOptions) {
		this.file = options.file;
		this.stateOf = options.state;
		this.targets = options.targets;
		this.brief = options.brief ?? renderBrief;
		this.onProblem = options.onProblem;
		this.clock = options.clock ?? Date.now;
		this.retryFirstMs = options.retryFirstMs ?? RETRY_FIRST_MS;
		this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
		this.failuresBeforeProblem = options.failuresBeforeProblem ?? FAILURES_BEFORE_PROBLEM;
		this.concurrency = options.concurrency ?? 8;
		this.rows = this.load();
	}

	/** Append one row; safe inside a store transaction because it never throws. */
	enqueue(effect: Effect): void {
		const at = this.clock();
		const row: EffectRow = { seq: (this.seq += 1), at, effect, attempts: 0, due: at };
		this.rows.push(row);
		this.append(row);
		this.schedule();
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.schedule();
	}

	/** Stop starting rows and wait for the running ones; waiting rows stay on disk. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.clearTimer();
		await Promise.allSettled([...this.running.values()]);
	}

	/** Wait until nothing is running and no row can start now; rows waiting for a retry stay. */
	async idle(): Promise<void> {
		for (;;) {
			this.pump();
			if (this.running.size === 0 && !this.hasRunnable()) return;
			await Promise.allSettled([...this.running.values()]);
			if (this.running.size === 0 && !this.hasRunnable()) return;
		}
	}

	/** Rows waiting for their next attempt, in queue order. */
	pending(): EffectRow[] {
		return this.rows.map((row) => ({ ...row }));
	}

	/** Consecutive failures of one kind, reset by its next success. */
	failuresOf(kind: Effect["kind"]): number {
		return this.failures.get(kind) ?? 0;
	}

	kick(): void {
		this.schedule();
	}

	// -------------------------------------------------------------- dispatch

	private pump(): void {
		this.clearTimer();
		if (!this.started || this.stopped) return;
		const rows = [...this.rows].sort((a, b) => a.seq - b.seq);
		const busy = new Set(this.running.keys());
		for (const row of this.runnable(rows)) {
			if (this.running.size >= this.concurrency) break;
			const key = orderKey(row.effect);
			if (busy.has(key)) continue;
			this.launch(row, key);
			busy.add(key);
		}
		this.schedule();
	}

	/** Rows that may start now: due, not already running, and not behind an older row on their key. */
	private runnable(rows: readonly EffectRow[]): EffectRow[] {
		const now = this.clock();
		const busy = new Set(this.running.keys());
		const ready: EffectRow[] = [];
		for (const row of rows) {
			if (row.due > now || busy.has(orderKey(row.effect)) || this.blocked(row, rows)) continue;
			ready.push(row);
		}
		return ready;
	}

	/** A row waits for an older row of its kind, or for an older row of an earlier stage, on the same key. */
	private blocked(row: EffectRow, rows: readonly EffectRow[]): boolean {
		const key = orderKey(row.effect);
		const stage = STAGE[row.effect.kind];
		return rows.some((other) => {
			if (other === row || other.seq > row.seq) return false;
			if (orderKey(other.effect) !== key) return false;
			if (other.effect.kind === row.effect.kind) return true;
			const otherStage = STAGE[other.effect.kind];
			return stage !== undefined && otherStage !== undefined && otherStage < stage;
		});
	}

	private launch(row: EffectRow, key: string): void {
		const task = this.perform(row)
			.catch((error: unknown) => this.failed(row, error))
			.finally(() => {
				this.running.delete(key);
				this.schedule();
			});
		this.running.set(key, task);
	}

	private async perform(row: EffectRow): Promise<void> {
		const state = this.stateOf();
		const outcome = this.resolve(row.effect, state);
		if (outcome === undefined) {
			// The command that queued the row rolled back or was superseded: it has nothing left to do.
			this.succeeded(row);
			return;
		}
		await outcome();
		this.succeeded(row);
	}

	/** What a row still has to do, or `undefined` when live state says it is moot. */
	private resolve(effect: Effect, state: State): (() => Promise<void> | void) | undefined {
		switch (effect.kind) {
			case "prepare": {
				const ticket = state.tickets[effect.ticketId];
				const assignment = state.assignments[effect.assignmentId];
				if (ticket === undefined || assignment === undefined || !liveTicket(ticket)) return undefined;
				if (assignment.state === "ended" || assignment.preparedAt !== undefined) return undefined;
				const request: LaunchRequest = { ticket, assignment, brief: this.brief(ticket, assignment) };
				return () => this.targets.prepare(request);
			}
			case "launch": {
				const ticket = state.tickets[effect.ticketId];
				const assignment = state.assignments[effect.assignmentId];
				if (ticket === undefined || assignment === undefined || !liveTicket(ticket)) return undefined;
				if (assignment.state !== "pending") return undefined;
				const request: LaunchRequest = { ticket, assignment, brief: this.brief(ticket, assignment) };
				return () => this.targets.launch(request);
			}
			case "deliver": {
				const ticket = state.tickets[effect.ticketId];
				const assignment = state.assignments[effect.assignmentId];
				if (ticket === undefined || assignment === undefined || assignment.state === "ended" || !liveTicket(ticket)) return undefined;
				const wanted = new Set(effect.inputIds);
				const inputs = undeliveredInputs(ticket).filter((input) => wanted.has(input.id));
				if (inputs.length === 0) return undefined;
				return () => this.targets.deliver(ticket, assignment, inputs);
			}
			case "endAssignment": {
				const ticket = state.tickets[effect.ticketId];
				const assignment = state.assignments[effect.assignmentId];
				if (ticket === undefined || assignment === undefined) return undefined;
				return () => this.targets.end(ticket, assignment, effect.reason);
			}
			case "requestStatus": {
				const ticket = state.tickets[effect.ticketId];
				const assignment = state.assignments[effect.assignmentId];
				if (ticket === undefined || assignment === undefined || !liveTicket(ticket)) return undefined;
				return () => this.targets.requestStatus(ticket, assignment);
			}
			case "reply":
				return () => this.targets.reply(effect.message);
			case "relay":
				return () => this.targets.relay(effect.message);
		}
	}

	// ---------------------------------------------------------------- outcome

	private succeeded(row: EffectRow): void {
		const index = this.rows.indexOf(row);
		if (index >= 0) this.rows.splice(index, 1);
		this.failures.set(row.effect.kind, 0);
		this.compact();
	}

	private failed(row: EffectRow, error: unknown): void {
		row.attempts += 1;
		const delay = Math.min(this.retryMaxMs, this.retryFirstMs * 2 ** Math.min(row.attempts - 1, 16));
		row.due = this.clock() + delay;
		const count = (this.failures.get(row.effect.kind) ?? 0) + 1;
		this.failures.set(row.effect.kind, count);
		this.compact();
		if (count === this.failuresBeforeProblem) {
			this.onProblem?.({
				kind: row.effect.kind,
				code: `effect_${row.effect.kind}`,
				message: `${row.effect.kind} failed ${count} times in a row: ${String(error).slice(0, 300)}`,
				count,
				at: this.clock(),
			});
		}
	}

	// ------------------------------------------------------------------- disk

	private load(): EffectRow[] {
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		const rows: EffectRow[] = [];
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			const row = parseRow(line);
			if (row === undefined) continue;
			rows.push(row);
			this.seq = Math.max(this.seq, row.seq);
		}
		return rows.sort((a, b) => a.seq - b.seq);
	}

	private append(row: EffectRow): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, `${JSON.stringify(row)}\n`);
		} catch {
			/* The row still runs from memory; a lost line only costs a replay after a restart. */
		}
	}

	private compact(): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const temporary = `${this.file}.${process.pid}.tmp`;
			writeFileSync(temporary, this.rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
			renameSync(temporary, this.file);
		} catch {
			/* Done rows left on disk replay once and are skipped as moot. */
		}
	}

	// ---------------------------------------------------------------- timing

	private hasRunnable(): boolean {
		return this.runnable([...this.rows].sort((a, b) => a.seq - b.seq)).length > 0;
	}

	private schedule(): void {
		this.clearTimer();
		if (!this.started || this.stopped || this.rows.length === 0) return;
		if (this.hasRunnable()) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.pump();
			}, 0);
			this.timer.unref?.();
			return;
		}
		const now = this.clock();
		const next = Math.min(...this.rows.map((row) => row.due));
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.pump();
		}, Math.max(1, next - now));
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}

function orderKey(effect: Effect): string {
	switch (effect.kind) {
		case "reply":
			return `conversation:${effect.message.channel.conversation}`;
		case "relay":
			return `relay:${effect.message.id}`;
		default:
			return `ticket:${effect.ticketId}`;
	}
}

function parseRow(line: string): EffectRow | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row.seq !== "number" || typeof row.at !== "number" || typeof row.due !== "number") return undefined;
	if (typeof row.attempts !== "number" || row.effect === null || typeof row.effect !== "object") return undefined;
	return { seq: row.seq, at: row.at, due: row.due, attempts: row.attempts, effect: row.effect as Effect };
}

/** The default assignment text: mandate, scope, source and how to report. */
export function renderBrief(ticket: Ticket, assignment: Assignment): string {
	const rules = ticket.mandate.matchedRules;
	const lines = [
		`# Assignment ${assignment.id}`,
		`Ticket ${ticket.id} (${ticket.name}) on ${ticket.source}, thread ${ticket.thread}.`,
		"",
		"## Ticket scope",
		ticket.mandate.scope === "" ? "The request in the trigger." : ticket.mandate.scope,
		"",
		"## Mandate",
		`Accepted under policy version ${ticket.mandate.policyVersion}, strength ${ticket.mandate.strength}, requested by ${ticket.mandate.requester.id} as ${ticket.mandate.receivedAs}.`,
		rules.length === 0 ? "No policy rule applies." : `Matched rules: ${rules.join(", ")}.`,
		"",
		"## Reporting",
		"Report with sagent_report. Ordinary progress stays internal; a question for a person and a finished result reach the host by themselves.",
	];
	return lines.join("\n");
}
