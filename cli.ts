#!/usr/bin/env node
/**
 * `pi-superagent` (package `bin`): the headless side of the extension.
 *
 * `serve` is the headless host a supervisor starts: it takes the state
 * directory's lock, runs the passes, the source and the executor, and prints one
 * JSON line per domain event. Every other command is a client: it asks the
 * running host over `superagent.sock` through the runtime's wire helpers and
 * never opens the store itself, so a second process cannot write the directory.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Overview, Stage, TicketRow } from "./src/core/model.js";
import { createPaths, defaultStateRoot } from "./src/infra/paths.js";
import { createRuntime, wireCall, type Result } from "./src/app/runtime.js";
import { errorText, setLocale, t, type Locale } from "./src/i18n.js";

/** How often the headless host's keepalive timer fires; it only keeps the process alive. */
const KEEPALIVE_MS = 60_000;

// -------------------------------------------------------------------- roots

/** The state root the host on this machine uses; `--state-dir` wins, then `settings.stateDir`, then `PI_SUPERAGENT_DIR`. */
export function resolveStateRoot(explicit: string | undefined): string {
	if (explicit !== undefined && explicit.trim() !== "") return resolve(expandHome(explicit.trim()));
	const base = resolve(defaultStateRoot());
	const configured = settingsValue(base, ["stateDir"]);
	return typeof configured === "string" && configured.trim() !== "" ? resolve(expandHome(configured.trim())) : base;
}

/** The journal's last `limit` lines; an absent journal is empty, never an error. */
export function readJournalTail(root: string, limit: number): string[] {
	const file = createPaths(root).journalFile;
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	return lines.slice(-Math.max(1, limit));
}

// ----------------------------------------------------------------- commands

interface CliArgs {
	command: string | undefined;
	rest: string[];
	stateDir: string | undefined;
	json: boolean;
	limit: number | undefined;
	help: boolean;
}

export async function main(argv: readonly string[]): Promise<number> {
	const args = parse(argv);
	if (args.help || args.command === undefined || args.command === "help") {
		process.stdout.write(`${helpText()}\n`);
		return 0;
	}
	const root = resolveStateRoot(args.stateDir);
	setLocale(localeOf(root));
	try {
		switch (args.command) {
			case "serve":
				return await serve(root);
			case "status":
				return await status(root, args.json);
			case "stop": {
				const ticketId = args.rest[0];
				if (ticketId === undefined) {
					process.stderr.write(`${t("cli.badArgs")}\n`);
					return 2;
				}
				const reason = args.rest.slice(1).join(" ").trim();
				const result = await call(root, "stopTicket", reason === "" ? { ticketId } : { ticketId, reason });
				if (!result.ok) return report(result);
				process.stdout.write(`${t("cli.ok.stopped", { ticketId })}\n`);
				return 0;
			}
			case "poll": {
				const result = await call(root, "pollSource");
				if (!result.ok) return report(result);
				process.stdout.write(`${t("cli.ok.polled")}\n`);
				return 0;
			}
			case "log":
				return log(root, args.limit ?? 20);
			default:
				process.stderr.write(`${t("cli.unknown", { name: args.command })}\n${t("cli.usageHint")}\n`);
				return 2;
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/** A headless host: it owns the lock until a signal arrives. */
async function serve(root: string): Promise<number> {
	const runtime = createRuntime({ stateDir: root });
	const started = await runtime.start();
	if (!started.ok) {
		process.stderr.write(`${t("cli.serve.startFailed", { message: started.error })}\n`);
		return 1;
	}
	if (!runtime.isHost()) {
		process.stderr.write(`${t("cli.serve.locked", { root })}\n`);
		await runtime.stop();
		return 1;
	}
	setLocale(runtime.settings.get().panel.locale);
	runtime.onDomainEvent((event) => {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	});
	process.stdout.write(`${t("cli.serve.ready", { socket: createPaths(root).socketFile, pid: process.pid })}\n`);
	// The host's own loops are unref'd so a Pi session can exit; a headless host keeps itself alive until a signal.
	const keepAlive = setInterval(() => undefined, KEEPALIVE_MS);
	try {
		await new Promise<void>((stopped) => {
			process.once("SIGINT", stopped);
			process.once("SIGTERM", stopped);
		});
	} finally {
		clearInterval(keepAlive);
	}
	process.stdout.write(`${t("cli.serve.stopping")}\n`);
	await runtime.stop();
	return 0;
}

async function status(root: string, json: boolean): Promise<number> {
	const result = await call(root, "overview");
	if (!result.ok) return report(result);
	const view = result.value as Overview;
	if (json) {
		process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
		return 0;
	}
	const counts = countStages(view.tickets);
	const repository = repositoryOf(root);
	const lines = [
		t("cli.status.header"),
		repository === "" ? undefined : t("cli.status.repository", { repository }),
		t("cli.status.policy", { version: view.policyVersion }),
		view.host === null ? t("cli.status.hostNone") : t("cli.status.host", { pid: view.host.pid, time: isoTime(view.host.startedAt) }),
		view.paused ? t("cli.status.paused") : undefined,
		t("cli.status.tickets", counts),
		t("cli.status.triggers", { count: view.triggers.length }),
		view.problems.length === 0 ? undefined : t("cli.status.problems", { count: view.problems.length }),
		t("cli.status.sources", { list: view.sources.map((source) => source.id).join(", ") || t("panel.row.none") }),
	].filter((line): line is string => line !== undefined);
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

function log(root: string, limit: number): number {
	const file = createPaths(root).journalFile;
	if (!existsSync(file)) {
		process.stdout.write(`${t("cli.log.missing", { file })}\n`);
		return 0;
	}
	const lines = readJournalTail(root, limit);
	if (lines.length === 0) {
		process.stdout.write(`${t("cli.log.empty")}\n`);
		return 0;
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

async function call(root: string, command: string, args?: unknown): Promise<Result<unknown>> {
	const socketFile = createPaths(root).socketFile;
	const request = args === undefined ? { id: randomUUID(), command } : { id: randomUUID(), command, args };
	return wireCall(socketFile, request);
}

function report(failure: { ok: false; error: string; code?: string; values?: Record<string, string> }): number {
	process.stderr.write(`${errorText(failure)}\n`);
	return 1;
}

// ------------------------------------------------------------------ helpers

function parse(argv: readonly string[]): CliArgs {
	const parsed: CliArgs = { command: undefined, rest: [], stateDir: undefined, json: false, limit: undefined, help: false };
	const queue = [...argv];
	while (queue.length > 0) {
		const item = queue.shift();
		if (item === undefined) break;
		if (item === "-h" || item === "--help") {
			parsed.help = true;
			continue;
		}
		if (item === "--json") {
			parsed.json = true;
			continue;
		}
		if (item === "--state-dir") {
			parsed.stateDir = queue.shift();
			continue;
		}
		if (item.startsWith("--state-dir=")) {
			parsed.stateDir = item.slice("--state-dir=".length);
			continue;
		}
		if (item === "--limit") {
			parsed.limit = positiveInt(queue.shift());
			continue;
		}
		if (item.startsWith("--limit=")) {
			parsed.limit = positiveInt(item.slice("--limit=".length));
			continue;
		}
		if (parsed.command === undefined) parsed.command = item;
		else parsed.rest.push(item);
	}
	return parsed;
}

function positiveInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const number = Number.parseInt(value, 10);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

function helpText(): string {
	return [
		t("cli.usage"),
		"",
		t("cli.help.commands"),
		t("cli.help.serve"),
		t("cli.help.status"),
		t("cli.help.stop"),
		t("cli.help.poll"),
		t("cli.help.log"),
		"",
		t("cli.help.options"),
		t("cli.help.stateDir"),
		t("cli.help.help"),
	].join("\n");
}

function countStages(rows: readonly TicketRow[]): { person: number; working: number; idle: number } {
	const counts = { person: 0, working: 0, idle: 0 };
	for (const row of rows) counts[kindOf(row.stage)] += 1;
	return counts;
}

function kindOf(stage: Stage): "person" | "working" | "idle" {
	if (stage.kind === "person") return "person";
	return stage.kind === "idle" ? "idle" : "working";
}

function isoTime(at: number): string {
	return new Date(at).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function localeOf(root: string): Locale {
	const value = settingsValue(root, ["panel", "locale"]);
	return value === "zh" ? "zh" : "en";
}

function repositoryOf(root: string): string {
	const value = settingsValue(root, ["policy", "sources", "github", "repository"]);
	return typeof value === "string" ? value.trim() : "";
}

/** A JSON document value, as `settings.json` holds it. */
type SettingsValue = string | number | boolean | null | SettingsValue[] | { [key: string]: SettingsValue };

/** One value out of `settings.json`, read only: a client never opens the store. */
function settingsValue(root: string, path: readonly string[]): SettingsValue | undefined {
	let value: SettingsValue | undefined;
	try {
		value = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as SettingsValue;
	} catch {
		return undefined;
	}
	for (const key of path) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		value = value[key];
	}
	return value;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
	void main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
