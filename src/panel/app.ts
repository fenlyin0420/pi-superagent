/**
 * The `/superagent` overlay (docs/000-design.md "Panel").
 *
 * The component renders what the runtime gave it: a header, the three sections,
 * the keys under them, and an inline line editor for answering a person's
 * question. It owns its selection and its mode; every command is an injected
 * action, so the component never talks to the runtime, a source or a worker
 * directly, and a narrow terminal or a missing locale changes only the text.
 */
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Ms, Stage, Ticket } from "../core/model.js";
import { stageLabel } from "../core/stage.js";
import { getLocale, t, type Locale } from "../i18n.js";
import { actionFor, answerKey, clamped, keyHints, moved, type KeyMatcher, type PanelAction } from "./keys.js";
import { relativeTime, rowLine, sectionsOf, shortId, type PanelData, type PanelRow, type PanelSection } from "./rows.js";

/** The theme calls the panel makes; Pi's `Theme` satisfies it. */
export interface PanelStyle {
	fg(color: "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text", text: string): string;
	bold(text: string): string;
}

export type ActionResult = { ok: true } | { ok: false; message: string };

export type PanelDetailResult = { ok: true; detail: PanelDetail } | { ok: false; message: string };

export type PanelTriggersResult = { ok: true; triggers: PanelTrigger[] } | { ok: false; message: string };

/** One recent Trigger, as the panel lists them under `t`. */
export interface PanelTrigger {
	id: string;
	at: Ms;
	kind: string;
	text: string;
	status: string;
}

/** What `enter` opens: a ticket with the stage the runtime gave it. */
export interface PanelDetail {
	ticket: Ticket;
	stage: Stage;
	assignment: { state: string } | null;
}

/** Everything the panel may do; the entry point wires it to the runtime and words its failures. */
export interface PanelActions {
	load(): Promise<PanelData>;
	open(ticketId: string): Promise<PanelDetailResult>;
	answer(ticketId: string, answer: string): Promise<ActionResult>;
	retry(ticketId: string): Promise<ActionResult>;
	stop(ticketId: string): Promise<ActionResult>;
	unsubscribe(thread: string): Promise<ActionResult>;
	pause(): Promise<ActionResult>;
	resume(): Promise<ActionResult>;
	triggers(): Promise<PanelTriggersResult>;
	done(): void;
}

export interface PanelOptions {
	actions: PanelActions;
	data: PanelData;
	keys: KeyMatcher;
	style: PanelStyle;
	now?: () => Ms;
	requestRender?: () => void;
}

type Mode = "list" | "detail" | "triggers" | "answer";

const WIDE = 60;

export class PanelComponent implements Component {
	private readonly actions: PanelActions;
	private readonly keys: KeyMatcher;
	private readonly style: PanelStyle;
	private readonly clock: () => Ms;
	private readonly requestRender: () => void;
	private data: PanelData;
	private selected = 0;
	private mode: Mode = "list";
	private status = "";
	private detail: PanelDetail | undefined;
	private triggers: PanelTrigger[] = [];
	private answerText = "";
	private answerTicket = "";
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: PanelOptions) {
		this.actions = options.actions;
		this.keys = options.keys;
		this.style = options.style;
		this.data = options.data;
		this.clock = options.now ?? Date.now;
		this.requestRender = options.requestRender ?? (() => undefined);
	}

	render(width: number): readonly string[] {
		const columns = Math.max(1, width);
		if (this.cachedLines !== undefined && this.cachedWidth === columns) return this.cachedLines;
		const lines: string[] = [...this.header(columns), this.rule(columns)];
		switch (this.mode) {
			case "detail":
				lines.push(...this.detailLines(columns));
				break;
			case "triggers":
				lines.push(...this.triggerLines(columns));
				break;
			default:
				lines.push(...this.listLines(columns));
				break;
		}
		if (this.mode === "answer") lines.push(...this.answerLines(columns));
		if (this.status !== "") lines.push(this.style.fg("warning", this.fit(this.status, columns)));
		lines.push(this.style.fg("dim", this.fit(this.hint(columns), columns)));
		this.cachedWidth = columns;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		try {
			if (this.mode === "answer") {
				this.answerInput(data);
				return;
			}
			const action = actionFor(data, this.keys);
			if (action !== undefined) this.dispatch(action);
		} catch (error) {
			this.setStatus(messageOf(error));
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	// --------------------------------------------------------------- actions

	private dispatch(action: PanelAction): void {
		if (action === "close") {
			this.actions.done();
			return;
		}
		if (action === "cancel") {
			if (this.mode === "list") this.actions.done();
			else this.backToList();
			return;
		}
		if (action === "up" || action === "down") {
			if (this.mode !== "list") return;
			this.selected = moved(this.selected, this.selectable().length, action);
			this.invalidate();
			this.requestRender();
			return;
		}
		if (action === "triggers") {
			void this.showTriggers();
			return;
		}
		if (this.mode !== "list") {
			if (action === "open") this.backToList();
			return;
		}
		const row = this.selectedRow();
		if (row === undefined) return;
		switch (action) {
			case "open":
				void this.open(row.id);
				break;
			case "answer":
				this.startAnswer(row);
				break;
			case "retry":
				void this.run(() => this.actions.retry(row.id), t("panel.status.retried", { id: shortId(row.id) }));
				break;
			case "stop":
				void this.run(() => this.actions.stop(row.id), t("panel.status.stopped", { id: shortId(row.id) }));
				break;
			case "unsubscribe":
				void this.run(
					() => this.actions.unsubscribe(row.thread),
					t("panel.status.unsubscribed", { thread: row.thread }),
				);
				break;
			case "pause":
				void this.togglePause();
				break;
		}
	}

	private async open(ticketId: string): Promise<void> {
		try {
			const result = await this.actions.open(ticketId);
			if (!result.ok) {
				this.setStatus(result.message);
				return;
			}
			this.detail = result.detail;
			this.mode = "detail";
			this.setStatus("");
		} catch (error) {
			this.setStatus(messageOf(error));
		}
	}

	private async showTriggers(): Promise<void> {
		try {
			const result = await this.actions.triggers();
			if (!result.ok) {
				this.setStatus(result.message);
				return;
			}
			this.triggers = result.triggers;
			this.mode = "triggers";
			this.setStatus("");
		} catch (error) {
			this.setStatus(messageOf(error));
		}
	}

	private async togglePause(): Promise<void> {
		const resuming = this.data.paused;
		await this.run(
			() => (resuming ? this.actions.resume() : this.actions.pause()),
			resuming ? t("panel.status.resumed") : t("panel.status.paused"),
		);
	}

	private startAnswer(row: PanelRow): void {
		if (row.stage?.code !== "answer") {
			this.setStatus(t("panel.answer.unavailable"));
			return;
		}
		this.answerTicket = row.id;
		this.answerText = "";
		this.mode = "answer";
		this.invalidate();
		this.requestRender();
	}

	private answerInput(data: string): void {
		const key = answerKey(data, this.answerText);
		if (key.cancel) {
			this.answerText = "";
			this.mode = "list";
			this.invalidate();
			this.requestRender();
			return;
		}
		if (!key.submit) {
			this.answerText = key.text;
			this.invalidate();
			this.requestRender();
			return;
		}
		const answer = this.answerText.trim();
		const ticketId = this.answerTicket;
		this.answerText = "";
		this.mode = "list";
		if (answer === "") {
			this.invalidate();
			this.requestRender();
			return;
		}
		void this.run(() => this.actions.answer(ticketId, answer), t("panel.status.answerSent"));
	}

	private async run(action: () => Promise<ActionResult>, success: string): Promise<void> {
		this.invalidate();
		this.requestRender();
		let status = success;
		try {
			const result = await action();
			if (result.ok) await this.reload();
			else status = result.message;
		} catch (error) {
			status = messageOf(error);
		}
		this.setStatus(status);
	}

	private async reload(): Promise<void> {
		try {
			const data = await this.actions.load();
			this.data = data;
			this.selected = clamped(this.selected, this.selectable().length);
		} catch (error) {
			this.status = messageOf(error);
		}
		this.invalidate();
		this.requestRender();
	}

	private backToList(): void {
		this.mode = "list";
		this.detail = undefined;
		this.triggers = [];
		this.answerText = "";
		this.invalidate();
		this.requestRender();
	}

	private setStatus(status: string): void {
		this.status = status;
		this.invalidate();
		this.requestRender();
	}

	// ------------------------------------------------------------------ rows

	private locale(): Locale {
		return getLocale();
	}

	private selectable(): PanelRow[] {
		return this.sections().flatMap((section) => section.rows);
	}

	private sections(): PanelSection[] {
		return sectionsOf(this.data.rows, this.data.ended, this.locale());
	}

	private selectedRow(): PanelRow | undefined {
		return this.selectable()[this.selected];
	}

	// -------------------------------------------------------------- rendering

	private header(width: number): string[] {
		const repository = this.data.repository === "" ? t("panel.noRepository") : this.data.repository;
		const host =
			this.data.host.kind === "self"
				? t("panel.host.self")
				: this.data.host.kind === "other"
					? t("panel.host.other", { pid: this.data.host.pid })
					: t("panel.host.none");
		const policy = t("panel.policy", { version: this.data.policyVersion });
		const paused = this.data.paused ? `  ${t("panel.paused")}` : "";
		const title = this.style.fg("accent", this.style.bold(t("panel.title")));
		if (width >= WIDE) {
			const rest = `  ${t("panel.repository", { repository })}  ${host}  ${policy}${paused}`;
			return [this.fit(`${title}${rest}`, width)];
		}
		return [
			this.fit(`${title}  ${policy}${paused}`, width),
			this.style.fg("muted", this.fit(`${t("panel.repository", { repository })}  ${host}`, width)),
		];
	}

	private rule(width: number): string {
		return this.style.fg("dim", "─".repeat(Math.max(1, width)));
	}

	private sectionTitle(title: string, width: number): string {
		const label = `── ${title} `;
		const fill = Math.max(0, width - visibleWidth(label));
		return this.style.fg("muted", this.fit(`${label}${"─".repeat(fill)}`, width));
	}

	private listLines(width: number): string[] {
		const rows = this.selectable();
		if (rows.length === 0) return [this.style.fg("muted", this.fit(t("panel.empty"), width))];
		const lines: string[] = [];
		const now = this.clock();
		let index = 0;
		for (const section of this.sections()) {
			if (section.rows.length === 0) continue;
			lines.push(this.sectionTitle(section.title, width));
			for (const row of section.rows) {
				const line = rowLine(row, { width, selected: index === this.selected, now, locale: this.locale() });
				lines.push(index === this.selected ? this.style.fg("accent", line) : line);
				index += 1;
			}
		}
		return lines;
	}

	private detailLines(width: number): string[] {
		if (this.detail === undefined) return [this.style.fg("muted", this.fit(t("panel.loading"), width))];
		const { ticket, stage, assignment } = this.detail;
		const now = this.clock();
		const report = ticket.reports.at(-1);
		const lines: string[] = [
			this.style.fg("accent", this.fit(`${shortId(ticket.id)} ${collapse(ticket.name)}`, width)),
			this.fit(t("panel.detail.stage", { label: stageLabel(stage, this.locale()) }), width),
			this.fit(t("panel.detail.scope", { scope: collapse(ticket.mandate.scope) }), width),
			this.fit(t("panel.detail.thread", { thread: ticket.thread }), width),
			this.fit(t("panel.detail.source", { source: ticket.source }), width),
			this.fit(t("panel.detail.reports", { count: ticket.reports.length }), width),
			this.fit(t("panel.detail.updated", { time: relativeTime(ticket.updatedAt, now, this.locale()) }), width),
			this.fit(t("panel.detail.assignment", { state: assignment?.state ?? t("panel.row.none") }), width),
		];
		if (report !== undefined) {
			lines.push(this.fit(t("panel.detail.report", { kind: report.kind, text: collapse(report.text) }), width));
		}
		if (ticket.attention !== undefined) {
			lines.push(this.style.fg("warning", this.fit(t("panel.detail.question", { text: collapse(ticket.attention.question) }), width)));
		}
		return lines;
	}

	private triggerLines(width: number): string[] {
		const lines: string[] = [this.style.fg("accent", this.fit(t("panel.triggers.title"), width))];
		if (this.triggers.length === 0) {
			lines.push(this.style.fg("muted", this.fit(t("panel.triggers.empty"), width)));
			return lines;
		}
		const now = this.clock();
		for (const trigger of this.triggers.slice(0, 20)) {
			const time = relativeTime(trigger.at, now, this.locale());
			lines.push(this.fit(`${trigger.id}  ${trigger.status}  ${trigger.kind}  ${time}  ${collapse(trigger.text)}`, width));
		}
		return lines;
	}

	private answerLines(width: number): string[] {
		const prompt = `${t("panel.answer.prompt")}: ${this.answerText}▏`;
		const lines = [this.style.fg("accent", this.fit(prompt, width))];
		if (width >= WIDE) lines.push(this.style.fg("dim", this.fit(t("panel.answer.help"), width)));
		return lines;
	}

	private hint(width: number): string {
		if (this.mode === "detail") return t("panel.detail.back");
		if (this.mode === "triggers") return t("panel.triggers.back");
		return keyHints(width);
	}

	private fit(text: string, width: number): string {
		return truncateToWidth(text, Math.max(1, width));
	}
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
