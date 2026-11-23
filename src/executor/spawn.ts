/**
 * One worker turn: a `pi` subprocess whose stdout is a JSONL event stream and
 * whose exit is the end of the turn (docs/000-design.md "Worker protocol").
 *
 * Nothing here knows about Tickets: it starts a process, keeps the tail of both
 * streams, hands each complete JSON line to a listener, and resolves a
 * `TurnResult` that says whether the failure was a passing one.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { TurnResult } from "../core/ports.js";

/** How much of either stream is kept; its tail is what explains a failure. */
export const OUTPUT_LIMIT = 64 * 1024;
/** How long a killed process has to exit after SIGTERM before it gets SIGKILL. */
export const KILL_GRACE_MS = 5_000;

export interface TurnRequest {
	/** The Pi binary: `PI_SUPERAGENT_PI_BIN`, or `pi` on the PATH. */
	binary: string;
	sessionId: string;
	sessionDir: string;
	/** The worker extension, passed as `-e`. */
	workerExtension: string;
	/** The Ticket's directory; the turn runs there. */
	directory: string;
	/** The `-p` text: the rendered turn input. */
	input: string;
	/** Variables added on top of `process.env`, the `SAGENT_*` set. */
	env: Record<string, string>;
	/** No limit when omitted; the executor supplies one. */
	timeoutMs?: number;
	/** Every complete JSON-mode line, in order. */
	onEvent?: (event: unknown) => void;
}

export interface TurnHandle {
	readonly result: Promise<TurnResult>;
	/**
	 * SIGTERM, then SIGKILL after `KILL_GRACE_MS`. Resolves once the process is
	 * gone; the turn's result then carries `reason` as its error.
	 */
	kill(reason?: string): Promise<void>;
}

/** Starts one turn. The process never runs under a shell. */
export function startTurn(request: TurnRequest): TurnHandle {
	const child = spawn(
		request.binary,
		[
			"--session-id",
			request.sessionId,
			"--session-dir",
			request.sessionDir,
			"--mode",
			"json",
			"-p",
			request.input,
			"-e",
			request.workerExtension,
		],
		{
			cwd: request.directory,
			env: { ...process.env, ...request.env },
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		},
	);

	const decoder = new StringDecoder("utf8");
	let stdout = "";
	let stderr = "";
	let partial = "";
	let lastWords = "";
	let killed: string | undefined;
	let timedOut = false;
	let exitCode: number | null = null;
	let exited = false;
	let settled = false;

	let settle: (result: TurnResult) => void = () => {};
	const result = new Promise<TurnResult>((resolve) => {
		settle = resolve;
	});

	const emitLine = (line: string): void => {
		const trimmed = line.replace(/\r$/, "").trim();
		if (trimmed === "") return;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			return;
		}
		const words = assistantText(event);
		if (words !== undefined) lastWords = words;
		request.onEvent?.(event);
	};

	child.stdout.on("data", (chunk: Buffer) => {
		const text = decoder.write(chunk);
		stdout = appendBounded(stdout, text);
		partial += text;
		let at = partial.indexOf("\n");
		while (at >= 0) {
			emitLine(partial.slice(0, at));
			partial = partial.slice(at + 1);
			at = partial.indexOf("\n");
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = appendBounded(stderr, chunk.toString("utf8"));
	});

	const finish = (): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		if (partial.trim() !== "") emitLine(partial);
		const ok = exitCode === 0 && killed === undefined && !timedOut;
		const transient = !ok && (timedOut || isTransientFailure(stderr));
		const error = ok ? undefined : failureText();
		settle({
			ok,
			exitCode,
			lastWords: lastWords.replace(/\s+/g, " ").trim(),
			transient,
			...(error === undefined ? {} : { error }),
		});
	};

	const failureText = (): string => {
		if (timedOut) return `The turn timed out after ${Math.round((request.timeoutMs ?? 0) / 1000)}s.`;
		if (killed !== undefined) return `The turn was stopped: ${killed}.`;
		const tail = stderr.trim().slice(-2_000);
		if (exitCode === null) return `The turn could not finish.${tail === "" ? "" : `\n${tail}`}`;
		return `pi exited with code ${exitCode}.${tail === "" ? "" : `\n${tail}`}`;
	};

	const timeout =
		request.timeoutMs === undefined || request.timeoutMs <= 0
			? undefined
			: setTimeout(() => {
					timedOut = true;
					signal("SIGTERM");
				}, request.timeoutMs);
	if (timeout !== undefined) timeout.unref();

	const signal = (name: NodeJS.Signals): void => {
		if (exited) return;
		try {
			child.kill(name);
		} catch {
			/* The process is already gone. */
		}
	};

	child.on("error", (error: Error) => {
		stderr = appendBounded(stderr, `\n${error.message}\n${String((error as { code?: string }).code ?? "")}`);
		exited = true;
		exitCode = null;
		finish();
	});

	child.on("exit", (code) => {
		exitCode = code;
		exited = true;
	});

	child.on("close", (code) => {
		exitCode = code ?? exitCode;
		exited = true;
		finish();
	});

	const kill = (reason?: string): Promise<void> => {
		if (killed === undefined) killed = reason ?? "stopped by the host";
		if (exited || settled) return Promise.resolve();
		signal("SIGTERM");
		return new Promise<void>((resolve) => {
			const hard = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
			hard.unref();
			child.once("close", () => {
				clearTimeout(hard);
				resolve();
			});
		});
	};

	return { result, kill };
}

/**
 * A passing failure of the model provider or the network: an HTTP 408, 429 or
 * 5xx, or a refused, reset or timed-out connection, as 003 names them.
 */
export function isTransientFailure(text: string): boolean {
	if (text.trim() === "") return false;
	return TRANSIENT.some((pattern) => pattern.test(text));
}

const TRANSIENT: readonly RegExp[] = [
	/\b408\b/,
	/\b429\b/,
	/\b50[0-4]\b/,
	/ECONNRESET/,
	/ECONNREFUSED/,
	/ETIMEDOUT/,
	/EPIPE/,
	/EAI_AGAIN/,
	/ENOTFOUND/,
	/UND_ERR/,
	/socket hang up/i,
	/fetch failed/i,
	/network error/i,
	/overloaded/i,
	/rate limit/i,
];

/** The assistant text of a completed message, when the event is one. */
function assistantText(event: unknown): string | undefined {
	if (!isRecord(event) || event.type !== "message_end") return undefined;
	const message = event.message;
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("\n");
	return text === "" ? undefined : text;
}

function appendBounded(current: string, chunk: string): string {
	const joined = current + chunk;
	return joined.length <= OUTPUT_LIMIT ? joined : joined.slice(joined.length - OUTPUT_LIMIT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
