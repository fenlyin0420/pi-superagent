/**
 * What the panel shows, in the panel's terms (docs/000-design.md "Panel").
 *
 * A row's stage and label are given: the panel reads `ticketStage`'s answer and
 * `stageLabel`'s wording and never computes either itself. This module only
 * groups the rows the sections ask for, words the relative time, and lays one
 * row's columns out inside the width the terminal gives.
 */
import type { Ms, Stage, TicketRow } from "../core/model.js";
import { stageLabel } from "../core/stage.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getLocale, t, type Locale } from "../i18n.js";

export type SectionId = "person" | "working" | "ended";

/** Who runs this state directory, as far as this session can tell. */
export type PanelHost = { kind: "self" } | { kind: "other"; pid: number } | { kind: "none" };

export interface EndedRow {
	id: string;
	name: string;
	/** The end outcome, such as `merged` or `stopped`. */
	label: string;
	pulls: string[];
	endedAt: Ms;
}

/** One line of the panel, whatever its section. */
export interface PanelRow {
	id: string;
	name: string;
	label: string;
	glyph: string;
	pulls: string[];
	updatedAt: Ms;
	/** Null for a ticket that already ended: the stage table has no row for it. */
	stage: Stage | null;
	thread: string;
}

export interface PanelSection {
	id: SectionId;
	title: string;
	rows: PanelRow[];
}

export interface PanelData {
	repository: string;
	policyVersion: number;
	host: PanelHost;
	paused: boolean;
	rows: TicketRow[];
	ended: EndedRow[];
}

/** `ticket-12` reads `#12`; an id without a number is shown as it is. */
export function shortId(id: string): string {
	const match = /^[a-z]+-(\d+)$/i.exec(id);
	return match?.[1] === undefined ? id : `#${match[1]}`;
}

/** The marker a stage draws at the start of its row (docs/000-design.md "Panel"). */
export function stageGlyph(stage: Stage): string {
	if (stage.kind === "person") return "●";
	if (stage.code === "working") return "◐";
	if (stage.code === "queued" || stage.code === "idle") return "○";
	return "●";
}

export function panelRow(row: TicketRow, locale: Locale = getLocale()): PanelRow {
	return {
		id: row.id,
		name: row.name,
		label: stageLabel(row.stage, locale),
		glyph: stageGlyph(row.stage),
		pulls: row.pulls,
		updatedAt: row.updatedAt,
		stage: row.stage,
		thread: row.thread,
	};
}

export function endedRow(row: EndedRow): PanelRow {
	return {
		id: row.id,
		name: row.name,
		label: row.label,
		glyph: "✓",
		pulls: row.pulls,
		updatedAt: row.endedAt,
		stage: null,
		thread: "",
	};
}

/**
 * The three sections. A person's row outranks the rest; `working` holds the
 * tickets that need nobody, idle ones included, because they are open work that
 * a Trigger resumes.
 */
export function sectionsOf(
	rows: readonly TicketRow[],
	ended: readonly EndedRow[],
	locale: Locale = getLocale(),
): PanelSection[] {
	const person: PanelRow[] = [];
	const working: PanelRow[] = [];
	for (const row of rows) {
		const shaped = panelRow(row, locale);
		if (row.stage.kind === "person") person.push(shaped);
		else working.push(shaped);
	}
	const done = ended.map(endedRow);
	const sections: PanelSection[] = [
		{ id: "person", title: t("panel.section.person"), rows: person },
		{ id: "working", title: t("panel.section.working"), rows: working },
	];
	if (done.length > 0) sections.push({ id: "ended", title: t("panel.section.ended"), rows: done });
	return sections;
}

/** `2m`, `3h`, `now`: short enough for a column, long enough to read. */
export function relativeTime(at: Ms, now: Ms, locale: Locale = getLocale()): string {
	const elapsed = Math.max(0, now - at);
	if (elapsed < 5_000) return t("panel.time.now");
	if (elapsed < 60_000) return t("panel.time.seconds", { n: Math.floor(elapsed / 1_000) });
	if (elapsed < 3_600_000) return t("panel.time.minutes", { n: Math.floor(elapsed / 60_000) });
	if (elapsed < 86_400_000) return t("panel.time.hours", { n: Math.floor(elapsed / 3_600_000) });
	return t("panel.time.days", { n: Math.floor(elapsed / 86_400_000) });
}

export interface RowLineOptions {
	/** Columns the terminal gives the whole panel. */
	width: number;
	selected: boolean;
	now: Ms;
	locale?: Locale;
}

/**
 * One row inside `width` columns: the marker, the stage glyph, the id, the name,
 * then as many of the label, the pull requests and the age as fit. A terminal
 * narrower than 60 columns keeps the name and the stage only.
 */
export function rowLine(row: PanelRow, options: RowLineOptions): string {
	const width = Math.max(1, options.width);
	const locale = options.locale ?? getLocale();
	const marker = options.selected ? "› " : "  ";
	const head = `${marker}${row.glyph} ${shortId(row.id)} `;
	const meta: string[] = [];
	if (width >= 60) {
		const pulls = row.pulls.length === 0 ? t("panel.row.none") : t("panel.row.pulls", { pulls: row.pulls.join(",") });
		meta.push(row.label, pulls, relativeTime(row.updatedAt, options.now, locale));
	} else if (width >= 44) {
		meta.push(row.label);
	}
	const metaText = meta.join("  ");
	const room = width - visibleWidth(head) - (metaText === "" ? 0 : visibleWidth(metaText) + 2);
	if (room < 4) return truncateToWidth(`${head}${row.name}`, width);
	return truncateToWidth(`${head}${fit(row.name, room)}${metaText === "" ? "" : `  ${metaText}`}`, width);
}

/** One row for a place without a terminal, such as `/superagent list`. */
export function listLines(rows: readonly TicketRow[], now: Ms, locale: Locale = getLocale()): string[] {
	return rows.map((row) => rowLine(panelRow(row, locale), { width: 120, selected: false, now, locale }));
}

function fit(text: string, width: number): string {
	const cut = truncateToWidth(text, width);
	const pad = width - visibleWidth(cut);
	return pad > 0 ? `${cut}${" ".repeat(pad)}` : cut;
}
