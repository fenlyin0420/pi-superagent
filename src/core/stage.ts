/**
 * The Ticket stage table (docs/003-execution.md). The rows are read top to
 * bottom and the first match wins; the panel renders `stageLabel` and never
 * computes a stage itself.
 */
import type { Assignment, Input, Report, Stage, StageCode, Ticket } from "./model.js";
import type { Locale } from "./reasons.js";

/**
 * A ticket's stage. `assignment` is the latest one the caller holds (from
 * `state.assignments`), needed only by the rows that ask whether work is queued,
 * idle or running.
 */
export function ticketStage(ticket: Ticket, assignment?: Assignment): Stage {
	if (ticket.delivery) return { kind: "person", code: "delivery" };
	if (ticket.attention) return { kind: "person", code: "answer" };
	const report = lastReport(ticket);
	if (report?.kind === "ready") return { kind: "person", code: "review" };
	// A person's message lifts the hold, so the ticket falls through to the rows below.
	if (report && (report.kind === "blocked" || report.kind === "failed") && !personWroteSince(ticket, report)) {
		return { kind: "person", code: report.kind };
	}
	if (!assignment || assignment.state === "pending") return { kind: "working", code: "queued" };
	if (report?.kind === "waiting" || assignment.state === "ended") return { kind: "idle", code: "idle" };
	return { kind: "working", code: "working" };
}

const LABELS = {
	delivery: { en: "Input undelivered", zh: "输入未送达" },
	answer: { en: "Awaiting answer", zh: "待回答" },
	review: { en: "Awaiting review", zh: "待验收" },
	blocked: { en: "Blocked", zh: "待处理受阻" },
	failed: { en: "Failed", zh: "待处理失败" },
	queued: { en: "Queued", zh: "排队中" },
	idle: { en: "Waiting for a Trigger", zh: "等待新触发" },
	working: { en: "Working", zh: "执行中" },
} satisfies Record<StageCode, { en: string; zh: string }>;

export function stageLabel(stage: Stage, locale: Locale = "en"): string {
	return LABELS[stage.code][locale];
}

function lastReport(ticket: Ticket): Report | undefined {
	return ticket.reports.at(-1);
}

/**
 * Whether a message a person wrote reached the ticket after its report. A
 * Trigger becomes an input of kind `trigger` when it reaches a subscribed
 * ticket; `resume` is the message that resumed an ended one.
 */
function personWroteSince(ticket: Ticket, report: Report): boolean {
	return ticket.inputs.some((input) => isFromPerson(input) && input.at > report.at);
}

function isFromPerson(input: Input): boolean {
	return input.kind === "trigger" || input.kind === "resume";
}
