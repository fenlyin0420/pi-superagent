/**
 * The Executor: one Pi subprocess per worker turn, in the Ticket's own directory
 * (docs/000-design.md "Worker protocol", docs/003-execution.md "The Executor").
 *
 * Every port method is fire-and-forget. The adapter does the work and reports the
 * fact back through `EngineForExecutor`: an Assignment started, Inputs reached the
 * worker, Inputs were read, a turn ended, a Report arrived. The Engine never reads
 * this module's state, and this module never reads the Engine's.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assignment, AssignmentId, Input, InputId, ReportKind, Ticket, TicketId } from "../core/model.js";
import type { EngineForExecutor, Executor, LaunchRequest, ReportInput } from "../core/ports.js";
import type { Paths } from "../infra/paths.js";
import { KILL_GRACE_MS, startTurn, type TurnHandle, type TurnRequest } from "./spawn.js";

/** 003: a prepare command has ten minutes to finish. */
export const PREPARE_TIMEOUT_MS = 10 * 60_000;
/** A safety limit on one turn; 003 sets no per-turn limit. */
export const TURN_TIMEOUT_MS = 60 * 60_000;
/** 003: a turn that ended with background work keeps its slot for at most 30 minutes. */
export const BACKGROUND_LIMIT_MS = 30 * 60_000;
export const DEFAULT_MAX_WORKERS = 3;
/** 003: a passing failure is tried again three times with a growing backoff. */
export const DEFAULT_TRANSIENT_BACKOFF_MS: readonly number[] = [15_000, 30_000];
/** How long a turn waits for a worker slot, and the inbox poll fallback, before looking again. */
export const SLOT_POLL_MS = 2_000;
export const INBOX_POLL_MS = 1_000;
/** Bounded output of a prepare command, kept in its failure message. */
const PREPARE_OUTPUT_LIMIT = 8 * 1024;

const STATUS_PROMPT =
	"Report the current ticket status with sagent_report. This is a status-only request: do not resume implementation or perform external actions.";

const RETRY_NOTE = "The previous turn failed with a passing network or provider error. Continue the assignment from where it stands.";

const REPORT_KINDS: ReadonlySet<string> = new Set<ReportKind>([
	"progress",
	"waiting",
	"ready",
	"blocked",
	"failed",
	"dropped",
]);

/** What the runtime's settings say about execution; a fresh read on every use. */
export interface ExecutorSettings {
	/** Shell command run once per Ticket before its first turn; empty starts in an empty directory. */
	prepare?: string;
	/** Concurrent worker turns, not counting the extra slot for a person's message or a status request. */
	maxWorkers?: number;
	/** What the default prepare command branches from. */
	baseBranch?: string;
	/** Commands a worker may not run, passed as `SAGENT_BLOCKED_COMMANDS`. */
	blockedCommands?: string[];
	/** The repository the Source watches, for `SAGENT_GITHUB_REPOSITORY`. */
	repository?: string;
}

export interface PiExecutorOptions {
	engine: EngineForExecutor;
	paths: Paths;
	settings?: () => ExecutorSettings;
	/** The Pi binary, when `PI_SUPERAGENT_PI_BIN` is not set. */
	binary?: string;
	/** The extension a turn loads with `-e`; the package's `worker.js` by default. */
	workerExtension?: string;
	/** Runs one turn; tests pass a fake instead of a process. */
	startTurn?: (request: TurnRequest) => TurnHandle;
	/** Per-ticket variables the Source owns, such as the GitHub account and head ref. */
	environment?: (ticket: Ticket) => Record<string, string>;
	turnTimeoutMs?: number;
	backgroundLimitMs?: number;
	transientBackoffMs?: readonly number[];
	pollMs?: number;
	/** Where a failure in this adapter goes: a report that could not be recorded, an unreadable inbox line. */
	onError?: (error: unknown) => void;
}

export interface TurnParts {
	/** The rendered assignment: the Mandate, its scope and the delivery requirements. */
	assignment?: string;
	/** A request that is not an Input, such as a status prompt or a retry note. */
	request?: string;
	inputs?: readonly Input[];
}

/**
 * The text one turn receives: the Ticket it works on, its assignment, whatever
 * it is asked for now, and every Input that has not reached it yet.
 */
export function renderTurn(ticket: Ticket, parts: TurnParts): string {
	const lines = [`# Ticket ${ticket.name} (${ticket.id})`, "", `Directory: ${ticket.execution.directory}`, ""];
	const assignment = parts.assignment?.trim();
	if (assignment !== undefined && assignment !== "") lines.push("## Assignment", "", assignment, "");
	const request = parts.request?.trim();
	if (request !== undefined && request !== "") lines.push("## Request", "", request, "");
	const inputs = parts.inputs ?? [];
	if (inputs.length > 0) {
		lines.push("## Inputs", "");
		for (const [index, input] of inputs.entries()) {
			lines.push(`### ${index + 1}. ${inputLabel(input)}`, "", input.text.trim(), "");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The session id a Ticket's worker runs under. Pi accepts letters, numbers,
 * `.`, `_` and `-` only, while the Engine names the session `sagent/<ticket>`.
 */
export function piSessionId(sessionId: string): string {
	const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-");
	const trimmed = cleaned.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
	return trimmed === "" ? "sagent" : trimmed;
}

interface Parked {
	ticket: Ticket;
	assignment: Assignment;
	parts: TurnParts;
	/** A person's message or a status request may take the slot kept for it. */
	extra: boolean;
}

interface Inbox {
	offset: number;
	partial: string;
	watcher?: FSWatcher;
	timer: NodeJS.Timeout;
}

interface ShellResult {
	code: number | null;
	output: string;
}

export class PiExecutor implements Executor {
	private readonly engine: EngineForExecutor;
	private readonly paths: Paths;
	private readonly options: PiExecutorOptions;
	/** Turns that hold a worker slot, by assignment. */
	private readonly turns = new Map<AssignmentId, TurnHandle>();
	/** Inputs already put into a turn of this assignment, so a repeated delivery is not a second prompt. */
	private readonly rendered = new Map<AssignmentId, Set<InputId>>();
	/** Turns waiting for a slot or for their assignment's turn to end. */
	private readonly parked = new Map<AssignmentId, Parked>();
	/** The prepare command of each assignment, which its launch waits for. */
	private readonly preparing = new Map<AssignmentId, Promise<void>>();
	/** Assignments whose prepare command failed: their launch runs no turn. */
	private readonly broken = new Set<AssignmentId>();
	/** Assignments already reported as started, so prepare and launch report it once. */
	private readonly started = new Set<AssignmentId>();
	/** The assignment a Ticket's worker runs, for report files that name none. */
	private readonly current = new Map<TicketId, AssignmentId>();
	/** The limit at which a turn that ended with background work reports waiting. */
	private readonly background = new Map<TicketId, NodeJS.Timeout>();
	/** A turn's last report, which says whether it left work running behind it. */
	private readonly lastReport = new Map<AssignmentId, ReportKind>();
	private readonly inboxes = new Map<TicketId, Inbox>();
	private pumpTimer?: NodeJS.Timeout;
	private closing = false;

	constructor(options: PiExecutorOptions) {
		this.options = options;
		this.engine = options.engine;
		this.paths = options.paths;
	}

	// -------------------------------------------------------------- executor

	prepare(request: LaunchRequest): void {
		const { ticket, assignment } = request;
		this.openInbox(ticket.id);
		const task = this.prepareDirectory(request).catch((error: unknown) => {
			this.broken.add(assignment.id);
			this.fail(ticket.id, assignment.id, messageOf(error));
		});
		this.preparing.set(assignment.id, task);
	}

	launch(request: LaunchRequest): void {
		this.openInbox(request.ticket.id);
		void this.startLaunch(request.ticket, request.assignment, request.brief);
	}

	deliver(ticket: Ticket, assignment: Assignment, inputs: Input[]): void {
		const fresh = inputs.filter((input) => input.deliveredAt === undefined && this.rendered.get(assignment.id)?.has(input.id) !== true);
		if (fresh.length === 0) return;
		this.enqueue({ ticket, assignment, parts: { inputs: fresh }, extra: takesExtraSlot(fresh) });
	}

	async end(ticket: Ticket, assignment: Assignment, reason: string): Promise<void> {
		this.parked.delete(assignment.id);
		this.releaseBackground(ticket.id);
		this.broken.delete(assignment.id);
		this.started.delete(assignment.id);
		this.rendered.delete(assignment.id);
		this.lastReport.delete(assignment.id);
		this.closeInbox(ticket.id);
		if (this.current.get(ticket.id) === assignment.id) this.current.delete(ticket.id);
		const handle = this.turns.get(assignment.id);
		this.turns.delete(assignment.id);
		this.pump();
		if (handle !== undefined) await handle.kill(reason);
	}

	requestStatus(ticket: Ticket, assignment: Assignment): void {
		const waiting = this.pendingInputs(ticket, assignment.id).filter((input) => input.kind === "status");
		this.enqueue({
			ticket,
			assignment,
			parts: waiting.length > 0 ? { inputs: waiting } : { request: STATUS_PROMPT },
			extra: true,
		});
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		this.parked.clear();
		if (this.pumpTimer !== undefined) {
			clearTimeout(this.pumpTimer);
			this.pumpTimer = undefined;
		}
		for (const timer of this.background.values()) clearTimeout(timer);
		this.background.clear();
		for (const inbox of this.inboxes.values()) this.disposeInbox(inbox);
		this.inboxes.clear();
		const kills = [...this.turns.values()].map((handle) => handle.kill("restarted"));
		this.turns.clear();
		await Promise.allSettled(kills);
	}

	// ---------------------------------------------------------- preparation

	private async prepareDirectory({ ticket, assignment }: LaunchRequest): Promise<void> {
		if (this.closing) return;
		const directory = directoryOf(ticket, assignment);
		if (!existsSync(directory)) {
			mkdirSync(dirname(directory), { recursive: true });
			const command = this.settings().prepare?.trim() ?? "";
			const shell = command === "" ? this.defaultPrepare(ticket, directory) : command;
			const result = await runShell(shell, dirname(directory), this.environment(ticket), this.prepareTimeout());
			if (result.code !== 0) {
				throw new Error(`The prepare command failed${result.output === "" ? "" : `:\n${result.output}`}`);
			}
			mkdirSync(directory, { recursive: true });
		}
	}

	private defaultPrepare(ticket: Ticket, directory: string): string {
		const base = this.settings().baseBranch?.trim() ?? "";
		return `git worktree add ${shellQuote(directory)} -b ${shellQuote(`sagent/${ticket.execution.name}`)} ${shellQuote(base === "" ? "HEAD" : base)}`;
	}

	// --------------------------------------------------------------- launches

	private async startLaunch(ticket: Ticket, assignment: Assignment, brief: string): Promise<void> {
		const preparing = this.preparing.get(assignment.id);
		if (preparing !== undefined) await preparing;
		if (this.closing || this.broken.has(assignment.id)) return;
		this.startAssignment(ticket.id, assignment.id);
		this.current.set(ticket.id, assignment.id);
		const inputs = this.pendingInputs(ticket, assignment.id);
		this.enqueue({
			ticket,
			assignment,
			parts: inputs.length > 0 ? { assignment: brief, inputs } : { assignment: brief },
			extra: takesExtraSlot(inputs),
		});
	}

	private enqueue(entry: Parked): void {
		const parked = this.parked.get(entry.assignment.id);
		if (parked === undefined) {
			this.parked.set(entry.assignment.id, entry);
		} else {
			parked.parts = {
				assignment: parked.parts.assignment ?? entry.parts.assignment,
				request: parked.parts.request ?? entry.parts.request,
				inputs: [...(parked.parts.inputs ?? []), ...(entry.parts.inputs ?? [])],
			};
			parked.extra ||= entry.extra;
		}
		this.pump();
	}

	/** Starts what it can: a person's message and a status request first, then new work, while slots are free. */
	private pump(): void {
		if (this.closing) return;
		const parked = [...this.parked.values()];
		for (const entry of [...parked.filter((item) => item.extra), ...parked.filter((item) => !item.extra)]) {
			if (this.parked.get(entry.assignment.id) !== entry) continue;
			if (this.turns.has(entry.assignment.id)) continue;
			if (!this.slotFree(entry.extra)) break;
			this.parked.delete(entry.assignment.id);
			void this.runTurn(entry);
		}
		if (this.parked.size > 0) this.schedulePump();
	}

	private schedulePump(): void {
		if (this.pumpTimer !== undefined) return;
		this.pumpTimer = setTimeout(() => {
			this.pumpTimer = undefined;
			this.pump();
		}, this.pollMs());
		this.pumpTimer.unref();
	}

	private slotFree(extra: boolean): boolean {
		const used = this.turns.size + this.background.size;
		return used < this.maxWorkers() + (extra ? 1 : 0);
	}

	private async runTurn(entry: Parked): Promise<void> {
		const { ticket, assignment } = entry;
		const ids = (entry.parts.inputs ?? []).map((input) => input.id);
		const backoff = this.options.transientBackoffMs ?? DEFAULT_TRANSIENT_BACKOFF_MS;
		let attempt = 0;
		let parts = entry.parts;
		for (;;) {
			this.releaseBackground(ticket.id);
			this.current.set(ticket.id, assignment.id);
			this.lastReport.delete(assignment.id);
			const handle = this.startTurnProcess(ticket, assignment, renderTurn(ticket, parts));
			this.turns.set(assignment.id, handle);
			if (ids.length > 0) {
				for (const id of ids) this.markRendered(assignment.id, id);
				this.safe(() => this.engine.inputsDelivered(ticket.id, assignment.id, ids));
			}
			const result = await handle.result;
			this.turns.delete(assignment.id);
			if (this.closing) return;
			if (result.ok || !result.transient || attempt >= backoff.length) {
				this.finishTurn(ticket, assignment, ids, result);
				return;
			}
			attempt += 1;
			await delay(backoff[attempt - 1] ?? 0);
			if (this.closing) return;
			parts = { ...parts, request: RETRY_NOTE };
		}
	}

	private startTurnProcess(ticket: Ticket, assignment: Assignment, input: string): TurnHandle {
		const request: TurnRequest = {
			binary: this.binary(),
			sessionId: piSessionId(assignment.sessionId),
			sessionDir: this.paths.sessionDir(ticket.id),
			workerExtension: this.workerExtension(),
			directory: directoryOf(ticket, assignment),
			input,
			env: this.environment(ticket),
			timeoutMs: this.options.turnTimeoutMs ?? TURN_TIMEOUT_MS,
		};
		return (this.options.startTurn ?? startTurn)(request);
	}

	/**
	 * A turn ended: read what its worker wrote, record that the Inputs reached its
	 * session, take the failure as a Report, and either keep the slot for the work
	 * it left running or free it for what waits.
	 */
	private finishTurn(ticket: Ticket, assignment: Assignment, ids: InputId[], result: { ok: boolean; lastWords: string; error?: string }): void {
		this.drainInbox(ticket.id);
		if (ids.length > 0) this.safe(() => this.engine.inputsRead(ticket.id, ids));
		if (!result.ok) {
			this.fail(ticket.id, assignment.id, result.error ?? result.lastWords);
		}
		const background = !result.ok ? false : this.lastReport.get(assignment.id) === "progress";
		if (background) this.holdBackground(ticket, assignment, result.lastWords);
		else this.safe(() => this.engine.turnEnded(ticket.id, assignment.id));
		this.pump();
	}

	/**
	 * 003: a turn that ended with work still running keeps the Ticket's slot for at
	 * most 30 minutes; then it reports waiting with the worker's last words. A Pi
	 * turn is a process, so the work is what the worker said it left behind—its
	 * latest Report was `progress`.
	 */
	private holdBackground(ticket: Ticket, assignment: Assignment, lastWords: string): void {
		const limit = this.options.backgroundLimitMs ?? BACKGROUND_LIMIT_MS;
		const timer = setTimeout(() => {
			this.background.delete(ticket.id);
			const words = lastWords.trim() === "" ? "no last words" : lastWords.trim();
			this.safe(() =>
				this.engine.report(ticket.id, assignment.id, {
					kind: "waiting",
					text: `Background work did not report within ${Math.round(limit / 60_000)} minutes. Last words: ${words}`,
				}),
			);
			this.safe(() => this.engine.turnEnded(ticket.id, assignment.id));
			this.pump();
		}, limit);
		timer.unref();
		this.background.set(ticket.id, timer);
	}

	private releaseBackground(ticketId: TicketId): void {
		const timer = this.background.get(ticketId);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.background.delete(ticketId);
	}

	/** 003: the assignment's turn starts; prepare only makes the directory (ports: `launch` reports started). */
	private startAssignment(ticketId: TicketId, assignmentId: AssignmentId): void {
		if (this.started.has(assignmentId)) return;
		this.started.add(assignmentId);
		this.safe(() => this.engine.assignmentStarted(ticketId, assignmentId));
	}

	private fail(ticketId: TicketId, assignmentId: AssignmentId, text: string): void {
		const summary = text.trim() === "" ? "The worker turn failed." : text.trim().slice(0, 2_000);
		this.safe(() => this.engine.report(ticketId, assignmentId, { kind: "failed", text: summary }));
	}

	// ------------------------------------------------------------------ inbox

	private openInbox(ticketId: TicketId): Inbox {
		const existing = this.inboxes.get(ticketId);
		if (existing !== undefined) return existing;
		const file = this.paths.inboxFile(ticketId);
		mkdirSync(dirname(file), { recursive: true });
		const inbox: Inbox = { offset: sizeOf(file), partial: "", timer: setInterval(() => this.drainInbox(ticketId), this.pollMs()) };
		inbox.timer.unref();
		this.inboxes.set(ticketId, inbox);
		// The report file appears with the first report and is always appended to;
		// watching its directory survives its creation and the poll covers a missed event.
		try {
			inbox.watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
				if (name === null || name === basename(file)) this.drainInbox(ticketId);
			});
			inbox.watcher.unref?.();
		} catch (error) {
			this.warn(error);
		}
		return inbox;
	}

	private closeInbox(ticketId: TicketId): void {
		const inbox = this.inboxes.get(ticketId);
		if (inbox === undefined) return;
		this.inboxes.delete(ticketId);
		this.disposeInbox(inbox);
	}

	private disposeInbox(inbox: Inbox): void {
		clearInterval(inbox.timer);
		inbox.watcher?.close();
	}

	private drainInbox(ticketId: TicketId): void {
		const inbox = this.inboxes.get(ticketId);
		if (inbox === undefined) return;
		const file = this.paths.inboxFile(ticketId);
		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			return;
		}
		if (size < inbox.offset) {
			inbox.offset = 0;
			inbox.partial = "";
		}
		if (size === inbox.offset) return;
		const length = size - inbox.offset;
		const buffer = Buffer.allocUnsafe(length);
		let read = 0;
		let fd: number | undefined;
		try {
			fd = openSync(file, "r");
			read = readSync(fd, buffer, 0, length, inbox.offset);
		} catch (error) {
			this.warn(error);
			return;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
		inbox.offset += read;
		inbox.partial += buffer.subarray(0, read).toString("utf8");
		const lines = inbox.partial.split("\n");
		inbox.partial = lines.pop() ?? "";
		for (const line of lines) this.ingest(ticketId, line);
	}

	private ingest(ticketId: TicketId, line: string): void {
		if (line.trim() === "") return;
		const assignmentId = this.current.get(ticketId);
		if (assignmentId === undefined) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			this.warn(new Error(`The inbox of ${ticketId} has a line that is not JSON: ${line.slice(0, 200)}`));
			return;
		}
		if (!isRecord(value)) return;
		const named = stringOf(value.ticketId);
		if (named !== undefined && named !== ticketId) return;
		const tool = stringOf(value.tool) ?? "";
		switch (tool) {
			case "report":
				this.ingestReport(ticketId, assignmentId, value);
				return;
			case "note": {
				const text = stringOf(value.text) ?? "";
				if (text.trim() === "") return;
				// A worker's note is informational: it reaches the Ticket as progress, which asks nothing of a person.
				this.safe(() => this.engine.report(ticketId, assignmentId, { kind: "progress", text }));
				return;
			}
			case "follow": {
				const thread = stringOf(value.thread) ?? "";
				if (thread === "") return;
				this.safe(() => this.engine.followForContext(ticketId, thread));
				return;
			}
			case "handback": {
				const triggerId = stringOf(value.triggerId) ?? "";
				const reason = stringOf(value.reason) ?? "";
				if (triggerId === "") return;
				this.safe(() => this.engine.handback(ticketId, triggerId, reason));
				return;
			}
			case "unrelated": {
				const thread = stringOf(value.thread) ?? "";
				const reason = stringOf(value.reason) ?? "";
				if (thread === "") return;
				this.safe(() => this.engine.markUnrelated(ticketId, thread, reason));
				return;
			}
			case "status": {
				const ids = [...(this.rendered.get(assignmentId) ?? [])];
				if (ids.length > 0) this.safe(() => this.engine.inputsRead(ticketId, ids));
				return;
			}
			default:
				this.warn(new Error(`The inbox of ${ticketId} has an unknown tool line: ${tool}`));
		}
	}

	private ingestReport(ticketId: TicketId, assignmentId: AssignmentId, value: Record<string, unknown>): void {
		const kind = stringOf(value.kind) ?? "";
		if (!REPORT_KINDS.has(kind)) return;
		const text = (stringOf(value.text) ?? "").trim();
		if (text === "") return;
		const report: ReportInput = { kind: kind as ReportKind, text };
		const question = (stringOf(value.question) ?? "").trim();
		if (question !== "") {
			const options = Array.isArray(value.options) ? value.options.filter((item): item is string => typeof item === "string") : [];
			report.attention = options.length > 0 ? { question, options } : { question };
		}
		this.lastReport.set(assignmentId, kind as ReportKind);
		this.safe(() => this.engine.report(ticketId, assignmentId, report));
	}

	// ------------------------------------------------------------- internals

	private pendingInputs(ticket: Ticket, assignmentId: AssignmentId): Input[] {
		const rendered = this.rendered.get(assignmentId);
		return ticket.inputs.filter(
			(input) =>
				input.deliveredAt === undefined &&
				rendered?.has(input.id) !== true &&
				(input.assignmentId === undefined || input.assignmentId === assignmentId),
		);
	}

	private markRendered(assignmentId: AssignmentId, inputId: InputId): void {
		const rendered = this.rendered.get(assignmentId) ?? new Set<InputId>();
		rendered.add(inputId);
		this.rendered.set(assignmentId, rendered);
	}

	private environment(ticket: Ticket): Record<string, string> {
		const settings = this.settings();
		// SAGENT_DIR is the state directory the inbox lives in; the ticket's own
		// directory is the turn's working directory and SAGENT_TICKET_DIR.
		const env: Record<string, string> = {
			SAGENT_DIR: this.paths.root,
			SAGENT_TICKET_DIR: ticket.execution.directory,
			SAGENT_NAME: ticket.execution.name,
			SAGENT_TICKET: ticket.id,
			SAGENT_BLOCKED_COMMANDS: (settings.blockedCommands ?? []).join(","),
		};
		const repository = settings.repository?.trim() ?? "";
		if (repository !== "") env.SAGENT_GITHUB_REPOSITORY = repository;
		return { ...env, ...this.options.environment?.(ticket) };
	}

	private settings(): ExecutorSettings {
		return this.options.settings?.() ?? {};
	}

	private maxWorkers(): number {
		const configured = this.settings().maxWorkers;
		return typeof configured === "number" && configured >= 1 ? Math.floor(configured) : DEFAULT_MAX_WORKERS;
	}

	private pollMs(): number {
		return this.options.pollMs ?? SLOT_POLL_MS;
	}

	private prepareTimeout(): number {
		return PREPARE_TIMEOUT_MS;
	}

	private binary(): string {
		return process.env.PI_SUPERAGENT_PI_BIN?.trim() || this.options.binary?.trim() || "pi";
	}

	private workerExtension(): string {
		const configured = this.options.workerExtension?.trim() ?? "";
		return configured === "" ? defaultWorkerExtension() : configured;
	}

	private safe(action: () => void): void {
		try {
			action();
		} catch (error) {
			this.warn(error);
		}
	}

	private warn(error: unknown): void {
		this.options.onError?.(error);
	}
}

export function createPiExecutor(options: PiExecutorOptions): PiExecutor {
	return new PiExecutor(options);
}

/**
 * The worker extension at the package root, found from the built layout
 * (`dist/src/executor/`) or from the source one (`src/executor/`): a turn that
 * loaded the wrong path would start with no reporting tools at all.
 */
export function defaultWorkerExtension(): string {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 6; depth += 1) {
		for (const candidate of [join("dist", "worker.js"), "worker.js", "worker.ts"]) {
			const file = join(directory, candidate);
			if (existsSync(file)) return file;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return fileURLToPath(new URL("../../../../dist/worker.js", import.meta.url));
}

// ------------------------------------------------------------------ helpers

function directoryOf(ticket: Ticket, assignment: Assignment): string {
	const directory = assignment.directory?.trim() ?? "";
	return directory === "" ? ticket.execution.directory : directory;
}

function takesExtraSlot(inputs: readonly Input[]): boolean {
	return inputs.some((input) => input.kind === "resume" || input.kind === "status");
}

function inputLabel(input: Input): string {
	const parts: string[] = [input.kind];
	if (input.triggerId !== undefined) parts.push(input.triggerId);
	parts.push(new Date(input.at).toISOString());
	return parts.join(" · ");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

function sizeOf(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** One `sh -c` command with a limit, killed like a turn: SIGTERM, then SIGKILL. */
function runShell(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<ShellResult> {
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let output = "";
		let settled = false;
		let hard: NodeJS.Timeout | undefined;
		const limit = setTimeout(() => {
			child.kill("SIGTERM");
			hard = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
			hard.unref();
		}, timeoutMs);
		limit.unref();
		const append = (chunk: Buffer): void => {
			const joined = output + chunk.toString("utf8");
			output = joined.length <= PREPARE_OUTPUT_LIMIT ? joined : joined.slice(joined.length - PREPARE_OUTPUT_LIMIT);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(limit);
			if (hard !== undefined) clearTimeout(hard);
			resolve({ code, output: output.trim() });
		};
		child.on("error", (error: Error) => {
			append(Buffer.from(`\n${error.message}\n`));
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}
