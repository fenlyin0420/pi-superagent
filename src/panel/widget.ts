/**
 * The status widget above the editor: at most three lines that say how much
 * waits for a person, how much is moving, and whether this session hosts the
 * state directory (docs/000-design.md "Panel").
 */
import type { TicketRow } from "../core/model.js";
import { t, type Locale } from "../i18n.js";
import { sectionsOf, type PanelData, type PanelHost } from "./rows.js";

export const WIDGET_KEY = "pi-superagent";
export const WIDGET_MAX_LINES = 3;

export interface WidgetInput {
	rows: readonly TicketRow[];
	host: PanelHost;
	paused: boolean;
	locale?: Locale;
}

/** The widget's lines; the third appears only when this session is not the host. */
export function widgetLines(input: WidgetInput): string[] {
	const sections = sectionsOf(input.rows, [], input.locale);
	const person = sections[0]?.rows.length ?? 0;
	const working = sections[1]?.rows.length ?? 0;
	const idle = input.rows.filter((row) => row.stage.kind === "idle").length;
	const counts =
		input.rows.length === 0
			? t("widget.empty")
			: [t("widget.person", { n: person }), t("widget.working", { n: working - idle }), t("widget.idle", { n: idle })].join(" · ");
	const title = [t("widget.title"), counts];
	if (input.paused) title.push(t("widget.paused"));
	const lines = [title.join(" · ")];
	if (input.host.kind === "other") lines.push(t("widget.host.other", { pid: input.host.pid }));
	else if (input.host.kind === "none") lines.push(t("widget.host.none"));
	return lines.slice(0, WIDGET_MAX_LINES);
}

/** The widget from the panel's data, so both read the same rows the same way. */
export function widgetFromPanel(data: PanelData): string[] {
	return widgetLines({ rows: data.rows, host: data.host, paused: data.paused });
}
