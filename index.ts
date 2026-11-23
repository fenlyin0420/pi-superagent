/**
 * The Pi-facing surface of pi-superagent (docs/000-design.md "Runtime").
 *
 * The session that loads this extension starts a `Runtime`. When the state
 * directory's lock is free it becomes the **host**: it registers the router
 * tools, appends `prompts/router.md` to its system prompt and turns every
 * `RouterMessage` into a session message the model reads. A session that did not
 * get the lock is a **client**: it serves the panel, the widget and the
 * `/superagent` commands, each of which the runtime forwards over the socket.
 *
 * `/superagent` opens the panel; with a subcommand it acts on one ticket or on
 * processing itself, and prints a short notice. Nothing here throws into Pi: a
 * failure is a notice, never an unhandled rejection.
 */
import { readFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Overview, TicketRow } from "./src/core/model.js";
import { createRuntime, type Result, type Runtime, type TriggerRow } from "./src/app/runtime.js";
import { registerRouterTools } from "./src/app/tools/main.js";
import { errorText, setLocale, t } from "./src/i18n.js";
import { readJournalTail, resolveStateRoot } from "./cli.js";
import { PanelComponent, type ActionResult, type PanelActions, type PanelDetail } from "./src/panel/app.js";
import { listLines, relativeTime, type PanelData, type PanelHost } from "./src/panel/rows.js";
import { widgetFromPanel, WIDGET_KEY } from "./src/panel/widget.js";

/** The `customType` of every message this extension puts in the transcript. */
const MESSAGE_TYPE = "pi-superagent";
/** How long a burst of domain events may wait before the widget is rebuilt once. */
const WIDGET_REFRESH_MS = 200;
const TRIGGER_PREVIEW = 200;
const TRIGGERS_DEFAULT = 20;
const LOG_DEFAULT = 20;

const SUBCOMMANDS: readonly string[] = [
	"list",
	"triggers",
	"decide",
	"attach",
	"note",
	"stop",
	"retry",
	"unsubscribe",
	"pause",
	"resume",
	"poll",
	"host",
	"settings",
	"log",
	"help",
];

const DECISION_OUTCOMES: ReadonlySet<string> = new Set(["accept", "stop", "ignore", "unavailable"]);

let runtime: Runtime | undefined;
let toolsRegistered = false;
let routerRelease: (() => void) | undefined;
let widgetContext: ExtensionContext | undefined;
let widgetTimer: NodeJS.Timeout | undefined;

export default function superagent(pi: ExtensionAPI): void {
	const routerPrompt = readRouterPrompt();

	pi.on("session_start", async (_event, ctx) => {
		try {
			await boot(pi, ctx);
		} catch (error) {
			notify(ctx, messageOf(error), "error");
		}
	});

	pi.on("session_shutdown", async () => {
		await shutdown();
	});

	pi.on("before_agent_start", (event) => {
		if (routerPrompt === "" || runtime === undefined || !runtime.isHost()) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${routerPrompt}` };
	});

	pi.registerCommand("superagent", {
		description: t("command.description"),
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			try {
				await command(pi, args, ctx);
			} catch (error) {
				notify(ctx, messageOf(error), "error");
			}
		},
	});
}

// --------------------------------------------------------------------- boot

async function boot(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (runtime !== undefined) return;
	const started = createRuntime();
	const result = await started.start();
	if (!result.ok) {
		notify(ctx, result.error, "error");
		return;
	}
	runtime = started;
	setLocale(started.settings.get().panel.locale);
	started.onDomainEvent(() => scheduleWidget());
	if (started.isHost()) becomeHost(pi);
	if (ctx.mode === "tui") widgetContext = ctx;
	scheduleWidget();
}

/** Register the router's tools and its message sink, once. */
function becomeHost(pi: ExtensionAPI): void {
	const current = runtime;
	if (current === undefined) return;
	if (!toolsRegistered) {
		registerRouterTools(pi, current);
		toolsRegistered = true;
	}
	if (routerRelease !== undefined) return;
	routerRelease = current.onRouterMessage((message) => {
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: message.text,
				display: true,
				details: {
					kind: message.kind,
					at: message.at,
					ticketIds: message.ticketIds ?? [],
					triggerId: message.triggerId ?? null,
				},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});
}

async function shutdown(): Promise<void> {
	if (widgetTimer !== undefined) {
		clearTimeout(widgetTimer);
		widgetTimer = undefined;
	}
	routerRelease?.();
	routerRelease = undefined;
	toolsRegistered = false;
	widgetContext = undefined;
	const current = runtime;
	runtime = undefined;
	if (current !== undefined) {
		try {
			await current.stop();
		} catch {
			// Stopping is the last thing a session does; a failure here has no surface left to reach.
		}
	}
}

// ------------------------------------------------------------------ widget

function scheduleWidget(): void {
	if (widgetTimer !== undefined) return;
	widgetTimer = setTimeout(() => {
		widgetTimer = undefined;
		void refreshWidget();
	}, WIDGET_REFRESH_MS);
	widgetTimer.unref?.();
}

async function refreshWidget(): Promise<void> {
	const ctx = widgetContext;
	const current = runtime;
	if (ctx === undefined || current === undefined || ctx.mode !== "tui") return;
	try {
		ctx.ui.setWidget(WIDGET_KEY, widgetFromPanel(await loadPanelData(current)));
	} catch (error) {
		ctx.ui.setWidget(WIDGET_KEY, [messageOf(error)]);
	}
}

// ----------------------------------------------------------------- command

async function command(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const current = runtime;
	if (current === undefined) {
		notify(ctx, t("command.runtime"), "warning");
		return;
	}
	const parsed = parseArgs(args);
	const name = parsed.positional[0] ?? "";
	const rest = parsed.positional.slice(1);
	switch (name) {
		case "":
			await openPanel(current, ctx);
			scheduleWidget();
			return;
		case "list":
			await commandList(current, ctx, parsed.flags.has("json"));
			return;
		case "triggers":
			await commandTriggers(current, ctx, parsed.flags);
			return;
		case "decide":
			await commandDecide(current, ctx, rest, parsed.flags);
			return;
		case "attach":
			await commandAttach(current, ctx, rest, parsed.flags);
			return;
		case "note":
			await commandNote(current, ctx, rest);
			return;
		case "stop":
			await commandStop(current, ctx, rest, parsed.flags);
			return;
		case "retry":
			await commandRetry(current, ctx, rest);
			return;
		case "unsubscribe":
			await commandUnsubscribe(current, ctx, rest);
			return;
		case "pause":
			await commandPause(current, ctx, true);
			return;
		case "resume":
			await commandPause(current, ctx, false);
			return;
		case "poll":
			await commandPoll(current, ctx);
			return;
		case "host":
			await commandHost(pi, current, ctx);
			return;
		case "settings":
			await commandSettings(current, ctx, rest, parsed.flags);
			return;
		case "log":
			commandLog(ctx, parsed.flags);
			return;
		case "help":
			notify(ctx, t("command.help"));
			return;
		default:
			notify(ctx, t("command.unknown", { name }), "warning");
	}
}

async function openPanel(current: Runtime, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		notify(ctx, t("command.panelUnavailable"), "info");
		await commandList(current, ctx, false);
		return;
	}
	let data: PanelData;
	try {
		data = await loadPanelData(current);
	} catch (error) {
		notify(ctx, messageOf(error), "error");
		return;
	}
	await ctx.ui.custom<undefined>(
		(tui, theme, keybindings, done) =>
			new PanelComponent({
				actions: panelActions(current, () => done(undefined)),
				data,
				keys: keybindings,
				style: theme,
				requestRender: () => tui.requestRender(),
			}),
		{ blocked: { kind: "question", message: t("panel.title") } },
	);
}

function panelActions(current: Runtime, done: () => void): PanelActions {
	return {
		load: () => loadPanelData(current),
		open: async (ticketId) => {
			const result = await current.openTicket({ ticketId });
			if (!result.ok) return { ok: false, message: errorText(result) };
			const detail: PanelDetail = {
				ticket: result.value.ticket,
				stage: result.value.stage,
				assignment: result.value.assignment,
			};
			return { ok: true, detail };
		},
		answer: (ticketId, answer) => acting(current.answer({ ticketId, answer })),
		retry: (ticketId) => acting(current.retry({ ticketId })),
		stop: (ticketId) => acting(current.stopTicket({ ticketId })),
		unsubscribe: (thread) => acting(current.unsubscribe({ thread })),
		pause: () => acting(current.pause()),
		resume: () => acting(current.resume()),
		triggers: async () => {
			const result = await current.triggers({ limit: TRIGGERS_DEFAULT });
			return result.ok ? { ok: true, triggers: result.value } : { ok: false, message: errorText(result) };
		},
		done,
	};
}

async function acting(pending: Promise<Result<unknown>>): Promise<ActionResult> {
	const result = await pending;
	return result.ok ? { ok: true } : { ok: false, message: errorText(result) };
}

/**
 * The panel's data. `ended` stays empty: the runtime's rows are the open
 * tickets, and an ended ticket's row needs a view the runtime does not expose.
 */
async function loadPanelData(current: Runtime): Promise<PanelData> {
	const overview = await current.overview();
	if (!overview.ok) throw new Error(errorText(overview));
	const repository = current.policy().sources.github?.repository.trim() ?? "";
	return {
		repository,
		policyVersion: overview.value.policyVersion,
		host: hostOf(current, overview.value),
		paused: overview.value.paused,
		rows: overview.value.tickets,
		ended: [],
	};
}

function hostOf(current: Runtime, overview: Overview): PanelHost {
	if (current.isHost()) return { kind: "self" };
	return overview.host === null ? { kind: "none" } : { kind: "other", pid: overview.host.pid };
}

// -------------------------------------------------------------- subcommands

async function commandList(current: Runtime, ctx: ExtensionContext, json: boolean): Promise<void> {
	const result = await current.rows();
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	if (json) {
		notify(ctx, JSON.stringify(result.value, null, 2));
		return;
	}
	notify(ctx, listText(result.value));
}

function listText(rows: readonly TicketRow[]): string {
	if (rows.length === 0) return t("command.list.empty");
	return [t("command.list.header"), ...listLines(rows, Date.now())].join("\n");
}

async function commandTriggers(current: Runtime, ctx: ExtensionContext, flags: Map<string, string>): Promise<void> {
	const result = await current.triggers({ limit: numberFlag(flags, "limit", TRIGGERS_DEFAULT) });
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	notify(ctx, triggerText(result.value));
}

function triggerText(rows: readonly TriggerRow[]): string {
	if (rows.length === 0) return t("command.triggers.empty");
	const now = Date.now();
	const lines = rows.map((row) =>
		t("command.triggers.row", {
			id: row.id,
			status: row.status,
			kind: row.kind,
			time: relativeTime(row.at, now),
			text: oneLine(row.text).slice(0, TRIGGER_PREVIEW),
		}),
	);
	return [t("command.triggers.header"), ...lines].join("\n");
}

async function commandDecide(
	current: Runtime,
	ctx: ExtensionContext,
	rest: readonly string[],
	flags: Map<string, string>,
): Promise<void> {
	const triggerId = rest[0];
	const outcome = rest[1];
	if (triggerId === undefined || outcome === undefined || !DECISION_OUTCOMES.has(outcome)) {
		notify(ctx, t("command.usage.decide"), "warning");
		return;
	}
	const result = await current.decide({
		triggerId,
		outcome: outcome as "accept" | "stop" | "ignore" | "unavailable",
		basis: flags.get("basis"),
		scope: flags.get("scope"),
	});
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	notify(ctx, t("command.decided", { outcome, triggerId, decisionId: result.value.decisionId }));
	scheduleWidget();
}

async function commandAttach(
	current: Runtime,
	ctx: ExtensionContext,
	rest: readonly string[],
	flags: Map<string, string>,
): Promise<void> {
	const ticketId = rest[0];
	const triggerId = rest[1];
	if (ticketId === undefined || triggerId === undefined) {
		notify(ctx, t("command.usage.attach"), "warning");
		return;
	}
	const result = await current.attach({ ticketId, triggerId, note: flags.get("note") });
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	notify(ctx, t("command.attached", { ticketId, triggerId }));
	scheduleWidget();
}

async function commandNote(current: Runtime, ctx: ExtensionContext, rest: readonly string[]): Promise<void> {
	const ticketId = rest[0];
	const text = rest.slice(1).join(" ").trim();
	if (ticketId === undefined || text === "") {
		notify(ctx, t("command.usage.note"), "warning");
		return;
	}
	const result = await current.note({ ticketId, text });
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	notify(ctx, t("command.noted", { ticketId }));
	scheduleWidget();
}

async function commandStop(
	current: Runtime,
	ctx: ExtensionContext,
	rest: readonly string[],
	flags: Map<string, string>,
): Promise<void> {
	const ticketId = rest[0];
	if (ticketId === undefined) {
		notify(ctx, t("command.usage.stop"), "warning");
		return;
	}
	const reason = flags.get("reason") ?? (rest.slice(1).join(" ").trim() || undefined);
	const result = await current.stopTicket({ ticketId, reason });
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	notify(ctx, t("command.stopped", { ticketId }));
	scheduleWidget();
}

async function commandRetry(current: Runtime, ctx: ExtensionContext, rest: readonly string[]): Promise<void> {
	const ticketId = rest[0];
	if (ticketId === undefined) {
		notify(ctx, t("command.usage.retry"), "warning");
		return;
	}
	const result = await current.retry({ ticketId });
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	notify(ctx, t("command.retried", { ticketId }));
	scheduleWidget();
}

async function commandUnsubscribe(current: Runtime, ctx: ExtensionContext, rest: readonly string[]): Promise<void> {
	const thread = rest[0];
	if (thread === undefined) {
		notify(ctx, t("command.usage.unsubscribe"), "warning");
		return;
	}
	const result = await current.unsubscribe({ thread });
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	notify(ctx, t("command.unsubscribed", { thread }));
	scheduleWidget();
}

async function commandPause(current: Runtime, ctx: ExtensionContext, pause: boolean): Promise<void> {
	const result = pause ? await current.pause() : await current.resume();
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	notify(ctx, pause ? t("command.paused") : t("command.resumed"));
	scheduleWidget();
}

async function commandPoll(current: Runtime, ctx: ExtensionContext): Promise<void> {
	const result = await current.pollSource();
	if (!result.ok) {
		notify(ctx, errorText(result), "error");
		return;
	}
	notify(ctx, t("command.polled"));
	scheduleWidget();
}

async function commandHost(pi: ExtensionAPI, current: Runtime, ctx: ExtensionContext): Promise<void> {
	if (current.isHost()) {
		becomeHost(pi);
		notify(ctx, t("command.hosting"));
		scheduleWidget();
		return;
	}
	const acquired = await current.acquireHost();
	if (!acquired) {
		notify(ctx, t("command.hostHeld"), "warning");
		return;
	}
	becomeHost(pi);
	notify(ctx, t("command.hosting"));
	scheduleWidget();
}

async function commandSettings(
	current: Runtime,
	ctx: ExtensionContext,
	rest: readonly string[],
	flags: Map<string, string>,
): Promise<void> {
	const settings = current.settings;
	if (rest[0] === "locale") {
		const next = rest[1];
		if (next !== "en" && next !== "zh") {
			notify(ctx, t("command.settings.localeUsage"), "warning");
			return;
		}
		if (!current.isHost()) {
			notify(ctx, t("command.hostOnly"), "warning");
			return;
		}
		const saved = settings.savePanel({ locale: next });
		if (!saved.ok) {
			notify(ctx, t("command.settings.invalid", { message: problemsText(saved.problems) }), "error");
			return;
		}
		setLocale(next);
		notify(ctx, t("command.settings.localeSaved", { locale: next }));
		scheduleWidget();
		return;
	}
	if (flags.has("json")) {
		notify(ctx, JSON.stringify(settings.get(), null, 2));
		return;
	}
	notify(ctx, settingsText(current));
}

function settingsText(current: Runtime): string {
	const settings = current.settings.get();
	const repository = settings.policy.sources.github?.repository.trim() ?? t("panel.noRepository");
	return [
		t("command.settings.header"),
		t("command.settings.policy", { version: settings.policy.version, mode: settings.policy.acceptMode }),
		t("command.settings.repository", { repository }),
		t("command.settings.rules", { count: settings.policy.rules.length }),
		t("command.settings.account", { account: settings.executor.account || t("panel.row.none") }),
		t("command.settings.locale", { locale: settings.panel.locale }),
		t("command.settings.stateDir", { dir: settings.stateDir || resolveStateRoot(undefined) }),
	].join("\n");
}

function commandLog(ctx: ExtensionContext, flags: Map<string, string>): void {
	const lines = readJournalTail(resolveStateRoot(undefined), numberFlag(flags, "limit", LOG_DEFAULT));
	notify(ctx, lines.length === 0 ? t("cli.log.empty") : lines.join("\n"));
}

// ---------------------------------------------------------------- helpers

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(message.trim(), type);
	} catch {
		// A surface that cannot render a notice must not fail the command that produced it.
	}
}

interface ParsedArgs {
	positional: string[];
	flags: Map<string, string>;
}

function parseArgs(input: string): ParsedArgs {
	const tokens = input.trim() === "" ? [] : input.trim().split(/\s+/);
	const positional: string[] = [];
	const flags = new Map<string, string>();
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const body = token.slice(2);
		const equals = body.indexOf("=");
		if (equals >= 0) {
			flags.set(body.slice(0, equals), body.slice(equals + 1));
			continue;
		}
		const next = tokens[index + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags.set(body, next);
			index += 1;
		} else {
			flags.set(body, "true");
		}
	}
	return { positional, flags };
}

function numberFlag(flags: Map<string, string>, name: string, fallback: number): number {
	const raw = flags.get(name);
	if (raw === undefined) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function problemsText(problems: ReadonlyArray<{ path: string; message: string }>): string {
	return problems.map((problem) => `${problem.path === "" ? "settings" : problem.path} ${problem.message}`).join("; ");
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `prompts/router.md`, next to the built package or next to the source it is built from. */
function readRouterPrompt(): string {
	for (const candidate of [
		new URL("../prompts/router.md", import.meta.url),
		new URL("./prompts/router.md", import.meta.url),
	]) {
		try {
			return readFileSync(candidate, "utf8").trim();
		} catch {
			continue;
		}
	}
	return "";
}
