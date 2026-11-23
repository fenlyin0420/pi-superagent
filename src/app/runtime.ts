/**
 * The composition root and the host lifecycle (docs/000-design.md "Runtime").
 *
 * This file holds no domain rules. It validates the settings, opens the store,
 * wires the gate, the engine, the effect queue, the source, the executor and the
 * outbox together, owns the state-directory lock, and decides which of the two
 * roles the process plays:
 *
 * - **host**: holds `<state>/lock`, runs the 2 second pass, the source, the
 *   executor and the socket server; it is the only writer.
 * - **client**: serves its own session and forwards every command over
 *   `<state>/superagent.sock`, newline-delimited JSON, so a second Pi session can
 *   drive the same state directory without writing it.
 *
 * Router messages reach a registered handler only on the host: the router
 * session is the host Pi session, and a client has no router.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	Actor,
	Assignment,
	State,
	ChannelAddress,
	DecisionId,
	DecisionKind,
	Ms,
	Overview,
	Policy,
	SourceId,
	Stage,
	StageKind,
	ThreadKey,
	Ticket,
	TicketId,
	TicketRow,
	Trigger,
	TriggerId,
} from "../core/model.js";
import type {
	Assessor,
	AssessorVerdict,
	Engine,
	Executor,
	LaunchRequest,
	OutboundMessage,
	PolicyPort,
	ReplyRequest,
	RouterMessage,
	Source as SourcePort,
	SourceScope,
	Store,
} from "../core/ports.js";
import { createEngine } from "../core/engine.js";
import { UserError, latestAssignment, type DomainEvent } from "../core/part.js";
import { stageLabel, ticketStage } from "../core/stage.js";
import { createLock, HostLock } from "../infra/lock.js";
import { createPaths, defaultStateRoot, type Paths } from "../infra/paths.js";
import { openStore, type StoreOptions } from "../infra/store.js";
import { createPolicyGate } from "../policy.js";
import { createPiExecutor, type ExecutorSettings as PiExecutorSettings } from "../executor/pi.js";
import { GithubSource } from "../sources/github.js";
import { pullsOf } from "../sources/github-pull.js";
import { EffectQueue, type EffectProblem } from "./effects.js";
import { eventNotice, problemMessage } from "./notices.js";
import { Outbox, type ReplyChannel } from "./outbox.js";
import { Passes } from "./passes.js";
import { SettingsFile, validateSettings, type Settings, type SettingsProblem } from "./settings.js";

// ------------------------------------------------------------------- results

/** Why a command could not be honoured. A user mistake is data, never an exception. */
export interface Failure {
	ok: false;
	error: string;
	/** The Engine's `UserError` code, `no_host` or `timeout`, so a surface can word it. */
	code?: string;
	values?: Record<string, string>;
	/** Set when a settings document was refused. */
	problems?: SettingsProblem[];
}

/**
 * What every command answers: one serialisable value, or a failure. `T` is
 * `void` for the commands that change state without reporting anything.
 */
export type Result<T = void> = { ok: true; value: T } | Failure;

export type Role = "host" | "client";

export type StartResult = { ok: true; role: Role } | { ok: false; error: string; problems?: SettingsProblem[] };

// ------------------------------------------------------------------- views

/** Everything the ticket overlay shows for one ticket. */
export interface TicketDetail {
	ticket: Ticket;
	stage: Stage;
	label: string;
	/** The latest assignment, or null for a ticket that has none yet. */
	assignment: Assignment | null;
}

/** One recent Trigger, in the shape `Overview` carries. */
export type TriggerRow = Overview["triggers"][number];

// ---------------------------------------------------------------- requests

export type DecideRequest =
	| {
			triggerId: TriggerId;
			outcome: DecisionKind;
			basis?: string;
			scope?: string;
			assess?: false;
	  }
	| {
			triggerId: TriggerId;
			/** Ask the configured Assessor for the verdict instead of naming one. */
			assess: true;
			outcome?: undefined;
			basis?: undefined;
			scope?: undefined;
	  };

export interface AttachRequest {
	ticketId: TicketId;
	triggerId: TriggerId;
	note?: string;
}

export interface NoteRequest {
	ticketId: TicketId;
	text: string;
}

export interface StopTicketRequest {
	ticketId: TicketId;
	reason?: string;
}

export interface RetryRequest {
	ticketId: TicketId;
}

export interface UnsubscribeRequest {
	thread: ThreadKey;
}

export interface DismissRequest {
	decisionId: string;
}

export interface AnswerRequest {
	ticketId: TicketId;
	answer: string;
}

export interface ReevaluateRequest {
	triggerId: TriggerId;
}

export interface OpenTicketRequest {
	ticketId: TicketId;
}

export interface TriggersRequest {
	/** How many of the newest Triggers to answer; 50 by default, at most 200. */
	limit?: number;
}

// ---------------------------------------------------------------- protocol

/** How long a client waits for the host before it answers `no_host`. */
export const WIRE_TIMEOUT_MS = 15_000;
/** The failure code for "nothing is listening on the socket". */
export const NO_HOST = "no_host";

export interface WireRequest {
	id: string;
	command: string;
	args?: unknown;
}

/** One line of the socket protocol: a client's request, or the host's answer to it. */
export type WireMessage =
	| { kind: "request"; id: string; command: string; args?: unknown }
	| { kind: "reply"; id: string; result: Result<unknown> };

/**
 * Encode one message as the single JSON line the socket carries. This is the
 * whole write side of the protocol, shared by the host and by `cli.ts`.
 */
export function wireEncode(message: WireMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export interface WireChunk {
	messages: WireMessage[];
	/** The unterminated tail, to be prefixed to the next read. */
	rest: string;
}

/**
 * Decode the complete lines in `text`; whatever follows the last newline comes
 * back as `rest`. A line that is not a message is dropped: a socket peer cannot
 * make the host throw.
 */
export function wireDecode(text: string): WireChunk {
	const lines = text.split("\n");
	const rest = lines.pop() ?? "";
	const messages: WireMessage[] = [];
	for (const line of lines) {
		const message = parseWireMessage(line);
		if (message !== undefined) messages.push(message);
	}
	return { messages, rest };
}

export interface WireOptions {
	timeoutMs?: Ms;
}

/**
 * Send one command to the host on `socketFile` and answer its result. This is
 * the whole client side of the protocol: no host listening is a clear failure,
 * not an exception, and a host that does not answer in time is `timeout`.
 */
export function wireCall(socketFile: string, request: WireRequest, options: WireOptions = {}): Promise<Result<unknown>> {
	const budget = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : WIRE_TIMEOUT_MS;
	return new Promise<Result<unknown>>((settle) => {
		let settled = false;
		let rest = "";
		let timer: NodeJS.Timeout | undefined;
		const socket = createConnection(socketFile);
		socket.setEncoding("utf8");
		const finish = (result: Result<unknown>): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			socket.destroy();
			settle(result);
		};
		timer = setTimeout(() => {
			finish({ ok: false, code: "timeout", error: `The host on ${socketFile} did not answer ${request.command} within ${budget} ms` });
		}, budget);
		timer.unref?.();
		socket.on("connect", () => {
			const message: WireMessage = { kind: "request", id: request.id, command: request.command };
			socket.write(wireEncode(request.args === undefined ? message : { ...message, args: request.args }));
		});
		socket.on("data", (chunk: string) => {
			const decoded = wireDecode(rest + chunk);
			rest = decoded.rest;
			for (const message of decoded.messages) {
				if (message.kind === "reply" && message.id === request.id) finish(message.result);
			}
		});
		socket.on("error", (error: Error) => {
			finish({ ok: false, code: NO_HOST, error: noHostMessage(socketFile, error) });
		});
		socket.on("close", () => {
			finish({ ok: false, code: NO_HOST, error: `The host on ${socketFile} closed the connection` });
		});
	});
}

function noHostMessage(socketFile: string, error: Error): string {
	const code = (error as NodeJS.ErrnoException).code ?? "";
	const because = code === "ENOENT" || code === "ECONNREFUSED" ? "nothing is listening" : error.message;
	return `No host answered on ${socketFile} (${because}); start the session that owns the state directory with /superagent host`;
}

function parseWireMessage(line: string): WireMessage | undefined {
	if (line.trim() === "") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id === "") return undefined;
	if (record.kind === "reply") {
		if (typeof record.result !== "object" || record.result === null || Array.isArray(record.result)) return undefined;
		return { kind: "reply", id: record.id, result: wireResult(record.result as Record<string, unknown>) };
	}
	if (typeof record.command !== "string") return undefined;
	return record.args === undefined
		? { kind: "request", id: record.id, command: record.command }
		: { kind: "request", id: record.id, command: record.command, args: record.args };
}

function wireResult(record: Record<string, unknown>): Result<unknown> {
	if (record.ok === true) return { ok: true, value: record.value };
	const failure: Failure = {
		ok: false,
		error: typeof record.error === "string" ? record.error : "The host gave no reason",
	};
	if (typeof record.code === "string") failure.code = record.code;
	if (isStringRecord(record.values)) failure.values = record.values;
	if (Array.isArray(record.problems)) failure.problems = record.problems as SettingsProblem[];
	return failure;
}

// ----------------------------------------------------------------- options

export interface RuntimeOptions {
	/** The state root; `settings.stateDir` or `PI_SUPERAGENT_DIR` answer when it is not set. */
	stateDir?: string;
	/** Wall clock, for tests and for the fixtures they seed. */
	now?: () => Ms;
	random?: () => number;
	/** The pass interval and its jitter: 2s and 500ms by default. */
	passIntervalMs?: Ms;
	passJitterMs?: Ms;
	/** How long a client waits for the host, 15s by default. */
	socketTimeoutMs?: Ms;
	/** How long a candidate may wait once it reached the router session. */
	evalTimeoutMs?: Ms;
	/** A store to use instead of the snapshot under the state dir. */
	store?: Store;
	/** Adapters a headless host or a test installs instead of the real ones. */
	executor?: Executor;
	source?: SourcePort;
	/** Held for the router session; the runtime never assesses on its own. */
	assessor?: Assessor;
}

interface Booted {
	paths: Paths;
	settings: SettingsFile;
	store: Store;
	policy: PolicyPort;
	queue: EffectQueue;
	outbox: Outbox;
	engine: Engine;
	executor: Executor;
	source: SourcePort;
	passes: Passes;
	lock: HostLock;
	/** Names the lock's holder, so two processes on one directory never share one. */
	sessionId: string;
	sourceStarted: boolean;
	/** Re-reads the snapshot; set when this session opened the store itself. */
	reload?: () => void;
}

/**
 * The store a session opens before it knows its role. A client only reads, but
 * a client that becomes the host must see what the previous host wrote before it
 * writes anything, so the snapshot is read again when the role changes.
 */
class ReloadingStore implements Store {
	private inner: Store;
	private readonly options: StoreOptions;

	constructor(options: StoreOptions) {
		this.options = options;
		this.inner = openStore(options);
	}

	get state(): State {
		return this.inner.state;
	}

	tx<T>(cmd: string, mutate: (state: State) => T, detail?: Record<string, unknown>): T {
		return this.inner.tx(cmd, mutate, detail);
	}

	flush(): void {
		this.inner.flush();
	}

	reload(): void {
		this.inner = openStore(this.options);
	}
}

type Phase = "new" | "running" | "stopped";

/** Commands that only read: they never ask for a pass afterwards. */
const READ_ONLY: ReadonlySet<string> = new Set(["overview", "rows", "triggers", "openTicket"]);
const KIND_RANK: Record<StageKind, number> = { person: 0, working: 1, idle: 2 };
const PROBLEMS_MAX = 50;
const TRIGGERS_RECENT = 20;
const TRIGGERS_MAX = 200;
const TRIGGER_TEXT_MAX = 300;
const HISTORY_MAX = 4_000;
const HISTORY_LINES = 20;

/**
 * The composition root for one Pi session. `start()` builds everything and
 * takes the host role when the lock is free; `stop()` releases it.
 */
export class Runtime {
	private readonly options: RuntimeOptions;
	private booted?: Booted;
	private phase: Phase = "new";
	private role: Role = "client";
	private recoveryPending = false;
	private server?: Server;
	/** The clients this host is answering now, closed on shutdown. */
	private readonly sockets = new Set<Socket>();
	private readonly routerHandlers = new Set<(message: RouterMessage) => void | Promise<void>>();
	private readonly eventHandlers = new Set<(event: DomainEvent) => void>();

	constructor(options: RuntimeOptions = {}) {
		this.options = options;
	}

	// ------------------------------------------------------------ lifecycle

	/**
	 * Read and validate the settings, open the store, wire every part, then take
	 * the host role if the lock is free. A process that cannot host is a client
	 * from the first command on.
	 */
	async start(): Promise<StartResult> {
		if (this.phase === "running") return { ok: true, role: this.role };
		if (this.phase === "stopped") return { ok: false, error: "The runtime has stopped" };
		const clock = this.clock;
		const baseRoot = resolve(this.options.stateDir?.trim() || defaultStateRoot());
		const settings = new SettingsFile({ file: join(baseRoot, "settings.json"), workRoot: join(baseRoot, "work"), clock });
		const loaded = settings.load();
		const validated = validateSettings(loaded.settings, { workRoot: join(baseRoot, "work"), clock });
		if (!validated.ok) {
			const refused = dedupeProblems([...loaded.problems, ...validated.problems]);
			return { ok: false, error: settingsError(refused), problems: refused };
		}
		const problems = dedupeProblems(loaded.problems);
		if (problems.length > 0) return { ok: false, error: settingsError(problems), problems };

		const root = rootOf(this.options.stateDir, validated.value.stateDir, baseRoot);
		const paths = createPaths(root);
		paths.ensureDirs();
		// A store handed in is the caller's (tests, a headless host); one opened here is re-read on promotion.
		let store: Store;
		let reload: (() => void) | undefined;
		if (this.options.store === undefined) {
			const own = new ReloadingStore({ stateFile: paths.stateFile, journalFile: paths.journalFile, clock });
			store = own;
			reload = () => own.reload();
		} else {
			store = this.options.store;
		}
		const policy = createPolicyGate({ policy: () => settings.policy(), self: () => this.selfActors() });
		// Every part below is referenced by a later one or by a closure that only
		// runs after `start` returns, so the wiring order is the dependency order.
		let outbox: Outbox;
		let executor: Executor;
		const queue = new EffectQueue({
			file: paths.effectsFile,
			state: () => store.state,
			targets: {
				prepare: (request: LaunchRequest) => executor.prepare(request),
				launch: (request: LaunchRequest) => executor.launch(request),
				deliver: (ticket, assignment, inputs) => executor.deliver(ticket, assignment, inputs),
				end: (ticket, assignment, reason) => executor.end(ticket, assignment, reason),
				requestStatus: (ticket, assignment) => executor.requestStatus(ticket, assignment),
				reply: async (message) => {
					await outbox.send(message);
				},
				relay: (message) => this.relay(message),
			},
			onProblem: (problem) => this.effectProblem(problem),
			clock,
		});
		const engine = createEngine({
			store,
			policy,
			effects: queue,
			now: clock,
			evalTimeoutMs: this.options.evalTimeoutMs,
			directoryFor: (name) => paths.ticketDir(name),
			emit: (event) => this.emit(event),
		});
		outbox = new Outbox({
			channel: (id) => this.channelOf(id),
			now: clock,
			problem: (code, message) => this.problem(code, message),
		});
		executor =
			this.options.executor ??
			createPiExecutor({
				engine: engine.forExecutor(),
				paths,
				settings: () => piExecutorSettings(settings.get(), settings.policy()),
				onError: (error) => this.problem("executor_failed", messageOf(error)),
			});
		const source =
			this.options.source ??
			new GithubSource({
				now: clock,
				random: this.options.random,
				tickets: () => Object.values(store.state.tickets),
			});
		const passes = new Passes({
			engine,
			effects: queue,
			onError: (error) => this.problem("pass_failed", messageOf(error)),
			intervalMs: this.options.passIntervalMs,
			jitterMs: this.options.passJitterMs,
			random: this.options.random,
		});
		this.booted = {
			paths,
			settings,
			store,
			policy,
			queue,
			outbox,
			engine,
			executor,
			source,
			passes,
			lock: createLock(paths.lockFile, clock),
			sessionId: `${process.pid}-${randomUUID()}`,
			sourceStarted: false,
			...(reload === undefined ? {} : { reload }),
		};
		this.phase = "running";
		const hosting = await this.acquireHost();
		return { ok: true, role: hosting ? "host" : "client" };
	}

	/**
	 * Take the host role when the state directory's lock is free, or keep it when
	 * this process already has it. Hosting starts the effect queue, the source,
	 * the pass loop and the socket server, and recovers what a previous host left
	 * running.
	 */
	async acquireHost(): Promise<boolean> {
		if (this.booted === undefined) return false;
		if (this.role === "host") return true;
		if (this.phase === "stopped") return false;
		const boot = this.booted;
		if (boot.lock.acquire(boot.sessionId) === undefined) return false;
		this.role = "host";
		// Whatever the previous holder wrote is what this process recovers and builds on.
		boot.reload?.();
		// A directory this host just took over is written out once, so its settings and
		// its snapshot exist to read and to edit; a client never writes either.
		try {
			boot.settings.ensureFile();
			boot.store.flush();
		} catch (error) {
			this.problem("state_write", messageOf(error));
		}
		boot.queue.start();
		this.startSource();
		this.recover();
		boot.passes.start();
		boot.passes.request();
		await this.listen();
		return true;
	}

	/** Stop the host's loops and release the lock. Idempotent. */
	async stop(): Promise<void> {
		if (this.phase === "stopped") return;
		const boot = this.booted;
		const wasRunning = this.phase === "running";
		this.phase = "stopped";
		if (boot !== undefined && wasRunning && this.role === "host") {
			// Stop taking new work, then let what is running end before the socket and the lock go.
			await boot.passes.stop();
			await boot.source.stop().catch((error: unknown) => this.problem("source_stop", messageOf(error)));
			await boot.queue.stop();
			await boot.executor.shutdown().catch((error: unknown) => this.problem("executor_stop", messageOf(error)));
			await this.unlisten(boot.paths.socketFile);
		}
		boot?.lock.release();
		this.booted = undefined;
		this.role = "client";
		this.routerHandlers.clear();
		this.eventHandlers.clear();
	}

	isHost(): boolean {
		return this.role === "host";
	}

	/** The settings document, for a surface that saves the panel's locale or the executor. */
	get settings(): SettingsFile {
		return this.boot.settings;
	}

	/** The live policy, as the gate and the workers read it. */
	policy(): Policy {
		return this.boot.settings.policy();
	}

	/** Run a pass now and wait until the effect queue has nothing left to start. */
	async idle(): Promise<void> {
		if (this.booted === undefined || this.role !== "host") return;
		const boot = this.booted;
		await boot.passes.pump();
		await boot.queue.idle();
	}

	// -------------------------------------------------------------- handlers

	/** Router messages, for the session that hosts the router. Answers the unregister. */
	onRouterMessage(handler: (message: RouterMessage) => void | Promise<void>): () => void {
		this.routerHandlers.add(handler);
		return () => {
			this.routerHandlers.delete(handler);
		};
	}

	/** Every domain event the engine emits. Answers the unregister. */
	onDomainEvent(handler: (event: DomainEvent) => void): () => void {
		this.eventHandlers.add(handler);
		return () => {
			this.eventHandlers.delete(handler);
		};
	}

	// ---------------------------------------------------------------- views

	async overview(): Promise<Result<Overview>> {
		return this.run("overview", {});
	}

	async rows(): Promise<Result<TicketRow[]>> {
		return this.run("rows", {});
	}

	async triggers(request: TriggersRequest = {}): Promise<Result<TriggerRow[]>> {
		return this.run("triggers", request);
	}

	async openTicket(request: OpenTicketRequest): Promise<Result<TicketDetail>> {
		return this.run("openTicket", request);
	}

	// ------------------------------------------------------------- commands

	/** Record what the router session decided about the Eval that holds a Trigger. */
	async decide(request: DecideRequest): Promise<Result<{ decisionId: DecisionId }>> {
		return this.run("decide", request);
	}

	/** A person's message the router session routes to an existing Ticket. */
	async attach(request: AttachRequest): Promise<Result<void>> {
		return this.run("attach", request);
	}

	async note(request: NoteRequest): Promise<Result<void>> {
		return this.run("note", request);
	}

	/** Write one message to a Source's Channel through the Outbox. */
	async reply(request: ReplyRequest): Promise<Result<void>> {
		return this.run("reply", request);
	}

	/** A person stops a Ticket; it never resumes. */
	async stopTicket(request: StopTicketRequest): Promise<Result<void>> {
		return this.run("stopTicket", request);
	}

	async retry(request: RetryRequest): Promise<Result<void>> {
		return this.run("retry", request);
	}

	async unsubscribe(request: UnsubscribeRequest): Promise<Result<void>> {
		return this.run("unsubscribe", request);
	}

	async dismiss(request: DismissRequest): Promise<Result<void>> {
		return this.run("dismiss", request);
	}

	async answer(request: AnswerRequest): Promise<Result<void>> {
		return this.run("answer", request);
	}

	async pause(): Promise<Result<void>> {
		return this.run("pause", {});
	}

	async resume(): Promise<Result<void>> {
		return this.run("resume", {});
	}

	async reevaluate(request: ReevaluateRequest): Promise<Result<void>> {
		return this.run("reevaluate", request);
	}

	/** Poll the source now instead of waiting for its interval. */
	async pollSource(): Promise<Result<void>> {
		return this.run("pollSource", {});
	}

	/**
	 * Save a policy the surface edited and tell the engine what it bears on. The
	 * settings file stays the only source of policy (invariant 6).
	 */
	async applyPolicy(input: unknown): Promise<Result<Policy>> {
		return this.run("applyPolicy", { policy: input });
	}

	// -------------------------------------------------------------- dispatch

	private async run<T>(command: string, args: unknown): Promise<Result<T>> {
		if (this.booted === undefined) return { ok: false, error: "The runtime is not started" };
		const result = this.role === "host" ? await this.local(command, args) : await this.forward(command, args);
		if (!result.ok) return result;
		return { ok: true, value: result.value as T };
	}

	private forward(command: string, args: unknown): Promise<Result<unknown>> {
		const request: WireRequest = { id: randomUUID(), command };
		return wireCall(this.boot.paths.socketFile, args === undefined ? request : { ...request, args }, {
			timeoutMs: this.options.socketTimeoutMs,
		});
	}

	/** Run one command against the live state. Answers a failure rather than throwing. */
	private async local(command: string, args: unknown): Promise<Result<unknown>> {
		if (this.booted === undefined) return { ok: false, error: "The runtime is not started" };
		try {
			const value = await this.perform(command, asRecord(args));
			if (!READ_ONLY.has(command)) this.boot.passes.request();
			return { ok: true, value };
		} catch (error) {
			return failureOf(error);
		}
	}

	private async perform(command: string, input: Record<string, unknown>): Promise<unknown> {
		const boot = this.boot;
		switch (command) {
			case "overview":
				return this.overviewNow();
			case "rows":
				return this.rowsNow();
			case "triggers":
				return this.triggersNow(optionalNumber(input, "limit", TRIGGERS_RECENT));
			case "openTicket":
				return this.ticketNow(required(input, "ticketId"));
			case "decide":
				return this.decideNow(input);
			case "attach":
				boot.engine.attach(required(input, "ticketId"), required(input, "triggerId"), optional(input, "note"));
				return undefined;
			case "note":
				boot.engine.note(required(input, "ticketId"), required(input, "text"));
				return undefined;
			case "reply":
				boot.engine.reply(replyRequestOf(input));
				return undefined;
			case "stopTicket":
				boot.engine.stopTicket(required(input, "ticketId"), optional(input, "reason"));
				return undefined;
			case "retry":
				boot.engine.retryTicket(required(input, "ticketId"));
				return undefined;
			case "unsubscribe":
				boot.engine.unsubscribe(required(input, "thread"));
				return undefined;
			case "dismiss":
				boot.engine.dismiss(required(input, "decisionId"));
				return undefined;
			case "answer":
				boot.engine.answerAttention(required(input, "ticketId"), required(input, "answer"));
				return undefined;
			case "pause":
				boot.engine.pause();
				return undefined;
			case "resume": {
				boot.engine.resume();
				if (this.recoveryPending) {
					this.recoveryPending = false;
					this.recover();
				}
				return undefined;
			}
			case "reevaluate":
				boot.engine.reevaluate(required(input, "triggerId"));
				return undefined;
			case "pollSource":
				await this.pollNow();
				return undefined;
			case "applyPolicy":
				return this.applyPolicyNow(input.policy);
			default:
				throw new Error(`Unknown command: ${command}`);
		}
	}

	private async decideNow(input: Record<string, unknown>): Promise<{ decisionId: DecisionId }> {
		const boot = this.boot;
		const triggerId = required(input, "triggerId");
		if (input.assess === true) {
			const verdict = await this.assess(triggerId);
			if (verdict === undefined) throw new Error("No assessor is configured; name an outcome instead");
			return { decisionId: boot.engine.decide(triggerId, verdict.kind, verdict.basis, verdict.scope) };
		}
		return {
			decisionId: boot.engine.decide(triggerId, decisionKindOf(input.outcome), optional(input, "basis"), optional(input, "scope")),
		};
	}

	private async pollNow(): Promise<void> {
		const boot = this.boot;
		if (!boot.sourceStarted) throw new Error("The host has no source running");
		await boot.source.poll();
	}

	private applyPolicyNow(value: unknown): Policy {
		const boot = this.boot;
		const from = boot.settings.policy();
		const saved = boot.settings.savePolicy(value ?? {});
		if (!saved.ok) {
			throw new CommandFailure({
				ok: false,
				error: settingsError(saved.problems),
				problems: saved.problems,
			});
		}
		if (saved.value.version !== from.version) boot.engine.forSettings().policyChanged(from, saved.value);
		return saved.value;
	}

	// ----------------------------------------------------------------- views

	private overviewNow(): Overview {
		const boot = this.boot;
		const state = boot.store.state;
		const holder = boot.lock.probe();
		return {
			policyVersion: boot.settings.policy().version,
			paused: state.pausedAt !== undefined,
			host: holder === null ? null : { pid: holder.pid, startedAt: holder.startedAt },
			tickets: this.rowsNow(),
			triggers: this.triggersNow(TRIGGERS_RECENT),
			problems: state.problems.map((problem) => ({ ...problem })),
			sources: Object.keys(boot.settings.policy().sources).map((id) => this.sourceRow(id)),
		};
	}

	private sourceRow(id: SourceId): Overview["sources"][number] {
		const boot = this.boot;
		const stored = boot.store.state.sources[id];
		const live = boot.sourceStarted && boot.source.id === id ? boot.source.status() : undefined;
		const lastPollAt = live?.lastPollAt ?? stored?.lastPollAt;
		const lastError = live?.lastError ?? stored?.lastError;
		const row: Overview["sources"][number] = { id };
		if (lastPollAt !== undefined) row.lastPollAt = lastPollAt;
		if (lastError !== undefined) row.lastError = lastError;
		return row;
	}

	private rowsNow(): TicketRow[] {
		const boot = this.boot;
		const state = boot.store.state;
		const locale = boot.settings.get().panel.locale;
		const rows: TicketRow[] = [];
		for (const ticket of Object.values(state.tickets)) {
			if (ticket.ended !== undefined) continue;
			const assignment = latestAssignment(state, ticket);
			const stage = ticketStage(ticket, assignment);
			rows.push({
				id: ticket.id,
				name: ticket.name,
				stage,
				label: stageLabel(stage, locale),
				source: ticket.source,
				thread: ticket.thread,
				scope: ticket.mandate.scope,
				reports: ticket.reports.length,
				pulls: pullsOf(ticket).map((number) => `#${number}`),
				updatedAt: ticket.updatedAt,
			});
		}
		return rows.sort((a, b) => KIND_RANK[a.stage.kind] - KIND_RANK[b.stage.kind] || b.updatedAt - a.updatedAt);
	}

	private triggersNow(limit: number): TriggerRow[] {
		const state = this.boot.store.state;
		const cap = Math.min(Math.max(1, limit), TRIGGERS_MAX);
		return Object.values(state.triggers)
			.sort((a, b) => b.at - a.at)
			.slice(0, cap)
			.map((trigger) => ({
				id: trigger.id,
				at: trigger.at,
				kind: trigger.kind,
				text: trigger.text.slice(0, TRIGGER_TEXT_MAX),
				status: state.dispositions[trigger.id]?.status ?? "stored",
			}));
	}

	private ticketNow(ticketId: TicketId): TicketDetail {
		const boot = this.boot;
		const state = boot.store.state;
		const ticket = state.tickets[ticketId];
		if (ticket === undefined) throw new UserError("unknownTicket");
		const assignment = latestAssignment(state, ticket);
		const stage = ticketStage(ticket, assignment);
		return {
			ticket: structuredClone(ticket),
			stage,
			label: stageLabel(stage, boot.settings.get().panel.locale),
			assignment: assignment === undefined ? null : structuredClone(assignment),
		};
	}

	// -------------------------------------------------------------- assessor

	/**
	 * The Assessor's judgement of the batch that holds a Trigger, composed from
	 * live state. A headless host uses it; a session with a router does not.
	 */
	private async assess(triggerId: TriggerId): Promise<AssessorVerdict | undefined> {
		const assessor = this.options.assessor;
		if (assessor === undefined) return undefined;
		const boot = this.boot;
		const state = boot.store.state;
		const trigger = state.triggers[triggerId];
		if (trigger === undefined) throw new UserError("unknownTrigger");
		const batch = Object.values(state.evals).find((item) => item.status !== "done" && item.triggerIds.includes(triggerId));
		const thread = batch?.thread ?? trigger.threads[0] ?? "";
		const record = state.threads[thread];
		const triggers = (batch?.triggerIds ?? [trigger.id]).flatMap((id) => collect(state.triggers[id]));
		const tickets = (record?.subscriptions ?? []).flatMap((subscription) => collect(state.tickets[subscription.ticketId]));
		const history = (record?.triggerIds ?? [])
			.flatMap((id) => historyLine(state.triggers[id]))
			.slice(-HISTORY_LINES)
			.join("\n")
			.slice(0, HISTORY_MAX);
		return assessor.assess({
			source: trigger.source,
			thread,
			triggers,
			history,
			tickets,
			policy: boot.settings.policy(),
			gate: boot.policy.gate(trigger),
		});
	}

	// ------------------------------------------------------------ host start

	private startSource(): void {
		const boot = this.boot;
		if (boot.sourceStarted) return;
		const scope = this.createScope(boot.source.id);
		try {
			boot.source.start(scope);
			boot.sourceStarted = true;
		} catch (error) {
			this.problem("source_start", messageOf(error));
		}
	}

	/**
	 * 003 "Failure and recovery": every Assignment a previous host left running is
	 * reported to the Engine, oldest Ticket first, so the ones with a note to
	 * replay start again in the order a person asked for them. A paused runtime
	 * recovers when a person resumes it.
	 */
	private recover(): void {
		const boot = this.boot;
		const state = boot.store.state;
		if (state.pausedAt !== undefined) {
			this.recoveryPending = true;
			return;
		}
		const running = Object.values(state.assignments).flatMap((assignment) => {
			if (assignment.state !== "running") return [];
			const ticket = state.tickets[assignment.ticketId];
			return ticket === undefined ? [] : [{ ticket, assignment }];
		});
		running.sort((a, b) => a.ticket.createdAt - b.ticket.createdAt || startedAt(a.assignment) - startedAt(b.assignment));
		for (const { ticket, assignment } of running) {
			try {
				boot.engine.forExecutor().assignmentInterrupted(ticket.id, assignment.id);
			} catch (error) {
				this.problem("recovery_failed", `Ticket ${ticket.id}: ${messageOf(error)}`);
			}
		}
		this.recoveryPending = false;
	}

	// ------------------------------------------------------------- source glue

	private createScope(id: SourceId): SourceScope {
		const scoped = (): Booted => this.boot;
		return {
			id,
			receive: (trigger) => {
				const result = scoped().engine.forSources().receive(trigger);
				scoped().passes.request();
				return result;
			},
			bindThread: (ticketId, thread, own) => {
				scoped().engine.forSources().bindThread(ticketId, thread, own);
				scoped().passes.request();
			},
			threadClosed: (thread, outcome, at) => {
				scoped().engine.forSources().threadClosed(thread, outcome, at);
				scoped().passes.request();
			},
			send: async (message: OutboundMessage) => {
				await scoped().outbox.send(message);
			},
			self: () => this.selfActor(id),
			policy: () => scoped().settings.policy(),
			position: (key) => scoped().store.state.sources[id]?.readPosition[key],
			setPosition: (key, value) => {
				const state = scoped().store.state;
				const record = state.sources[id] ?? { id, readPosition: {} };
				state.sources[id] = record;
				record.readPosition[key] = value;
				try {
					scoped().store.flush();
				} catch {
					// A cursor that did not reach the disk replays one poll at worst; a Source never throws into the host.
				}
			},
			problem: (code, message) => this.problem(code, message),
		};
	}

	private selfActor(id: SourceId): Actor | undefined {
		const stored = this.boot.store.state.sources[id]?.self;
		if (stored !== undefined) return stored;
		const account = this.boot.settings.get().executor.account.trim();
		return id === "github" && account !== "" ? { id: account, bot: false } : undefined;
	}

	private selfActors(): Record<SourceId, Actor | undefined> {
		if (this.booted === undefined) return {};
		const actors: Record<SourceId, Actor | undefined> = {};
		for (const id of Object.keys(this.booted.settings.policy().sources)) actors[id] = this.selfActor(id);
		return actors;
	}

	private channelOf(id: SourceId): ReplyChannel | undefined {
		const boot = this.booted;
		if (boot === undefined || boot.source.id !== id) return undefined;
		const channel = boot.source as Partial<ReplyChannel>;
		return typeof channel.listens === "function" && typeof channel.post === "function" ? (channel as ReplyChannel) : undefined;
	}

	// ------------------------------------------------------------- effects glue

	private effectProblem(problem: EffectProblem): void {
		this.problem(problem.code, problem.message);
	}

	/** A Source, the effect queue or a pass failed often enough to need a person. */
	private problem(code: string, message: string): void {
		if (this.role !== "host" || this.booted === undefined) return;
		const boot = this.booted;
		const at = this.clock();
		const detail = message.slice(0, 500);
		try {
			const count = boot.store.tx(
				"problem",
				(state) => {
					const existing = state.problems.find((item) => item.code === code && item.dismissedAt === undefined);
					if (existing === undefined) {
						state.problems.push({ at, code, message: detail, count: 1 });
						if (state.problems.length > PROBLEMS_MAX) state.problems.splice(0, state.problems.length - PROBLEMS_MAX);
						return 1;
					}
					existing.at = at;
					existing.message = detail;
					existing.count += 1;
					return existing.count;
				},
				{ code },
			);
			this.notify(problemMessage({ code, message: detail, at, count }));
		} catch {
			// A problem that cannot be recorded is not a reason to fail the work that met it.
		}
	}

	// ------------------------------------------------------------ router glue

	/** The Engine's events: the surface hears every one, the router hears the ones it must act on. */
	private emit(event: DomainEvent): void {
		queueMicrotask(() => {
			for (const handler of this.eventHandlers) {
				try {
					handler(event);
				} catch {
					// A listener that throws is a listener's problem; a domain command is not.
				}
			}
			if (this.role !== "host" || this.booted === undefined) return;
			const boot = this.booted;
			const message = eventNotice(event, (id) => boot.store.state.tickets[id]);
			if (message !== undefined) this.notify(message);
		});
	}

	/** An effect's relay: the router must act on it, so a handler that throws is retried by the queue. */
	private async relay(message: RouterMessage): Promise<void> {
		await this.deliver(message);
	}

	/** Fire and forget, for what a replayed retry would only repeat. */
	private notify(message: RouterMessage): void {
		void this.deliver(message).catch(() => undefined);
	}

	private async deliver(message: RouterMessage): Promise<void> {
		if (this.role !== "host" || this.booted === undefined || this.routerHandlers.size === 0) return;
		const boot = this.booted;
		for (const handler of [...this.routerHandlers]) await handler(message);
		const candidate = message.candidate;
		if (candidate === undefined) return;
		try {
			boot.engine.forMainSession().candidateDelivered(candidate.evalId);
		} catch (error) {
			this.problem("candidate_delivered", messageOf(error));
		}
	}

	// ----------------------------------------------------------------- socket

	private async listen(): Promise<void> {
		const boot = this.boot;
		if (this.server !== undefined) return;
		const file = boot.paths.socketFile;
		removeFile(file);
		const server = createServer((socket) => this.serve(socket));
		this.server = server;
		await new Promise<void>((listening, failed) => {
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				failed(error);
			};
			const onListening = (): void => {
				server.off("error", onError);
				listening();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(file);
		}).catch((error: unknown) => {
			this.server = undefined;
			this.problem("socket_failed", messageOf(error));
		});
		if (this.server === undefined) return;
		// The socket carries commands that write the state directory: only this user talks to it.
		try {
			chmodSync(file, 0o600);
		} catch {
			// The state directory's own mode still keeps the socket local.
		}
		server.on("error", (error: Error) => this.problem("socket_failed", messageOf(error)));
		// The host's loop keeps the process alive; the socket must not be the reason it stays up.
		server.unref();
	}

	private async unlisten(file: string): Promise<void> {
		const server = this.server;
		this.server = undefined;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		if (server !== undefined) {
			await new Promise<void>((closed) => {
				server.close(() => closed());
			});
		}
		removeFile(file);
	}

	/** One client connection: newline-delimited requests in, one reply line out each, in order. */
	private serve(socket: Socket): void {
		let rest = "";
		let chain: Promise<void> = Promise.resolve();
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			const decoded = wireDecode(rest + chunk);
			rest = decoded.rest;
			for (const message of decoded.messages) {
				if (message.kind !== "request") continue;
				chain = chain.then(async () => {
					const result = await this.local(message.command, message.args);
					if (!socket.destroyed) socket.write(wireEncode({ kind: "reply", id: message.id, result }));
				});
			}
		});
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("error", () => socket.destroy());
	}

	// --------------------------------------------------------------- helpers

	private get boot(): Booted {
		if (this.booted === undefined) throw new Error("The runtime is not started");
		return this.booted;
	}

	private clock = (): Ms => this.options.now?.() ?? Date.now();
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
	return new Runtime(options);
}

// ------------------------------------------------------------------ helpers

/** A failure a command reports with structure the surface can word. */
class CommandFailure extends Error {
	readonly failure: Failure;

	constructor(failure: Failure) {
		super(failure.error);
		this.name = "CommandFailure";
		this.failure = failure;
	}
}

function failureOf(error: unknown): Failure {
	if (error instanceof CommandFailure) return error.failure;
	if (error instanceof UserError) {
		const failure: Failure = { ok: false, error: error.message, code: error.code };
		if (Object.keys(error.values).length > 0) failure.values = error.values;
		return failure;
	}
	if (error instanceof Error) return { ok: false, error: error.message };
	return { ok: false, error: String(error) };
}

function settingsError(problems: readonly SettingsProblem[]): string {
	const first = problems[0];
	if (first === undefined) return "The settings are invalid";
	const at = first.path === "" ? "settings" : first.path;
	return `The settings are invalid: ${problems.length === 1 ? `${at} ${first.message}` : `${at} ${first.message} (and ${problems.length - 1} more)`}`;
}

function dedupeProblems(problems: readonly SettingsProblem[]): SettingsProblem[] {
	const seen = new Map<string, SettingsProblem>();
	for (const problem of problems) seen.set(`${problem.path}\u0000${problem.message}`, problem);
	return [...seen.values()];
}

function rootOf(explicit: string | undefined, fromSettings: string, baseRoot: string): string {
	const chosen = explicit?.trim() || fromSettings.trim();
	return chosen === "" ? baseRoot : resolve(expandHome(chosen));
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function piExecutorSettings(settings: Settings, policy: Policy): PiExecutorSettings {
	const repository = policy.sources.github?.repository.trim() ?? "";
	return {
		prepare: settings.executor.prepare,
		maxWorkers: settings.executor.concurrency,
		baseBranch: settings.executor.baseBranch,
		repository,
	};
}

function replyRequestOf(input: Record<string, unknown>): ReplyRequest {
	const channel = asRecord(input.channel);
	const conversation = typeof channel.conversation === "string" ? channel.conversation.trim() : "";
	if (conversation === "") throw new Error("A reply needs channel.conversation");
	const ref = typeof channel.ref === "string" ? channel.ref.trim() : "";
	const address: ChannelAddress = ref === "" ? { conversation } : { conversation, ref };
	const request: ReplyRequest = {
		source: required(input, "source"),
		thread: required(input, "thread"),
		channel: address,
		purpose: purposeOf(input.purpose),
		body: required(input, "body"),
	};
	const ticketId = optional(input, "ticketId");
	if (ticketId !== undefined) request.ticketId = ticketId;
	return request;
}

const PURPOSES: ReadonlySet<string> = new Set(["acknowledgement", "answer", "result", "attention"]);

function purposeOf(value: unknown): ReplyRequest["purpose"] {
	if (typeof value === "string" && PURPOSES.has(value)) return value as ReplyRequest["purpose"];
	throw new Error('A reply purpose is one of acknowledgement, answer, result or attention');
}

const KINDS: ReadonlySet<string> = new Set(["accept", "stop", "ignore", "unavailable"]);

function decisionKindOf(value: unknown): DecisionKind {
	if (typeof value === "string" && KINDS.has(value)) return value as DecisionKind;
	throw new Error('A decision outcome is one of accept, stop, ignore or unavailable');
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function required(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`A ${key} is required`);
	return value.trim();
}

function optional(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalNumber(input: Record<string, unknown>, key: string, fallback: number): number {
	const value = input[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function collect<T>(value: T | undefined): T[] {
	return value === undefined ? [] : [value];
}

function historyLine(trigger: Trigger | undefined): string[] {
	if (trigger === undefined) return [];
	return [`${trigger.actor.id} (${trigger.kind}) on ${trigger.threads.join(", ") || "no thread"}: ${collapse(trigger.text).slice(0, 600)}`];
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function startedAt(assignment: Assignment): Ms {
	return assignment.startedAt ?? 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((item) => typeof item === "string");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function removeFile(file: string): void {
	if (!existsSync(file)) return;
	try {
		unlinkSync(file);
	} catch {
		// A socket another process still owns stays; `listen` reports the failure it causes.
	}
}
