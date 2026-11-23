/**
 * Router-session messages: what the host Pi session reads (docs/000-design.md
 * "Notices", docs/004-prompts.md).
 *
 * A candidate asks the router for a Decision; a report, follow-up, notice and
 * problem tell it what happened. Everything here is bounded: the router reads a
 * card, never a whole issue body, and the card points at the ticket for the
 * rest. Message ids are stable per fact so a replayed relay stays one message.
 */
import type { Candidate, Report, Ticket, TicketId, Trigger, TriggerId } from "../core/model.js";
import type { DomainEvent } from "../core/part.js";
import type { RouterMessage } from "../core/ports.js";
import { reasonText } from "../core/reasons.js";

/** The most a router message carries; anything longer points at its ticket. */
export const MESSAGE_LIMIT = 1500;

const TRIGGER_PREVIEW = 600;
const TICKET_PREVIEW = 200;

export interface TriggerLookup {
	(id: TriggerId): Trigger | undefined;
}

export interface TicketLookup {
	(id: TicketId): Ticket | undefined;
}

export interface NoticeOptions {
	/** Resolves a Trigger a Candidate names, so the card can carry its text. */
	trigger?: TriggerLookup;
	ticket?: TicketLookup;
}

/**
 * A person's follow-up, a Ticket's end, a requeued Trigger and a dropped
 * subscription are the events the router still hears of; everything else stays
 * internal. Returns `undefined` when the event needs no message.
 */
export function eventNotice(event: DomainEvent, ticket: TicketLookup = () => undefined): RouterMessage | undefined {
	switch (event.type) {
		case "ticket.ended": {
			const ended = ticket(event.ticketId);
			const name = ended === undefined ? "" : ` (${ended.name})`;
			return {
				id: `notice-ended-${event.ticketId}-${event.at}`,
				kind: "notice",
				at: event.at,
				ticketIds: [event.ticketId],
				text: bound(`Ticket ${event.ticketId}${name} ended: ${event.outcome} by ${event.by} — ${event.reason}.`, { ticket: event.ticketId }),
			};
		}
		case "trigger.requeued":
			return {
				id: `notice-requeued-${event.triggerId}-${event.at}`,
				kind: "notice",
				at: event.at,
				triggerId: event.triggerId,
				text: `Trigger ${event.triggerId} is queued for a fresh assessment.`,
			};
		case "thread.unsubscribed":
			return {
				id: `notice-unsubscribed-${event.thread}-${event.ticketId}-${event.at}`,
				kind: "notice",
				at: event.at,
				ticketIds: [event.ticketId],
				text: bound(
					event.by === "person"
						? `A person removed the subscriptions on thread ${event.thread}.`
						: `Ticket ${event.ticketId} no longer follows thread ${event.thread}: its worker found it unrelated.`,
					{ ticket: event.ticketId },
				),
			};
		default:
			return undefined;
	}
}

/**
 * The card that asks the router for a Decision: the Trigger's text, the thread,
 * the Tickets already there and the rules the gate matched.
 */
export function candidateMessage(candidate: Candidate, options: NoticeOptions = {}): RouterMessage {
	const lookup = options.trigger;
	const triggers = candidate.triggerIds.map((id) => (lookup === undefined ? undefined : lookup(id))).filter(isTrigger);
	const primary = triggers[0];
	const lines = [
		`Candidate ${candidate.evalId} on ${candidate.thread} — ${candidate.strategy} basis.`,
		candidate.basis === "" ? "" : `Basis: ${candidate.basis}`,
		triggers.length === 0 ? `Triggers: ${candidate.triggerIds.join(", ")}` : "",
		...triggers.map(
			(trigger) =>
				`Trigger ${trigger.id} from ${trigger.actor.id} (${trigger.kind}): ${collapse(trigger.text).slice(0, TRIGGER_PREVIEW)}${trigger.text.length > TRIGGER_PREVIEW ? "…" : ""}`,
		),
		candidate.matchedRules.length === 0 ? "Matched rules: none" : `Matched rules: ${candidate.matchedRules.join(", ")}`,
		...candidate.reason.filter((reason) => reason.code !== "routed").map((reason) => `Refused: ${reasonText(reason)}`),
		candidate.tickets.length === 0
			? "Tickets on this thread: none"
			: `Tickets on this thread:\n${candidate.tickets.map((ticket) => `- ${ticket.id} (${ticket.state}): ${collapse(ticket.text).slice(0, TICKET_PREVIEW)}`).join("\n")}`,
		"Decide with sagent_decide: accept, attach, stop or ignore.",
	].filter((line) => line !== "");
	return {
		id: `candidate-${candidate.evalId}`,
		kind: "candidate",
		at: primary?.at ?? Date.now(),
		candidate,
		ticketIds: candidate.tickets.map((ticket) => ticket.id),
		triggerId: primary?.id,
		text: bound(lines.join("\n"), { candidate: candidate.evalId }),
	};
}

/**
 * A Report that a person must see: a question, a ready result, a blocker, a
 * failure or a hand-back. Ordinary progress stays on its Ticket.
 */
export function reportRelay(report: Report, ticket: Ticket, options: NoticeOptions = {}): RouterMessage | undefined {
	if (report.kind === "progress" && report.attention === undefined) return undefined;
	const question =
		report.attention === undefined
			? ""
			: [
					`Question for a person: ${collapse(report.attention.question)}`,
					...(report.attention.options ?? []).map((option) => `- ${collapse(option)}`),
					"Forward it to the person where the request was written; do not answer it yourself.",
				].join("\n");
	const text = [
		`Ticket ${ticket.id} (${ticket.name}) reported ${report.kind}: ${collapse(report.text)}`,
		question,
		`Thread ${ticket.thread} on ${ticket.source}.`,
	]
		.filter((line) => line !== "")
		.join("\n");
	return {
		id: `report-${ticket.id}-${report.at}`,
		kind: report.attention === undefined ? "report" : "followup",
		at: report.at,
		ticketIds: [ticket.id],
		text: bound(text, { ticket: ticket.id }),
	};
}

/**
 * A person's message that reached Tickets. Their workers decide it; the router
 * only acts when the person asks to stop the work.
 */
export function followupRelay(ticketIds: readonly TicketId[], trigger: Trigger, options: NoticeOptions = {}): RouterMessage {
	const lookup = options.ticket;
	const tickets = ticketIds.map((id) => (lookup === undefined ? undefined : lookup(id))).filter(isTicket);
	const reached =
		tickets.length === 0
			? ticketIds.map((id) => `- ${id}`).join("\n")
			: tickets.map((ticket) => `- ${ticket.id} (${ticket.name}, ${ticket.ended === undefined ? "open" : ticket.ended.outcome})`).join("\n");
	const text = [
		`A person's message reached ${ticketIds.length} ticket${ticketIds.length === 1 ? "" : "s"}:`,
		reached,
		`${trigger.actor.id} (${trigger.kind}) on ${trigger.threads[0] ?? "an unknown thread"}: ${collapse(trigger.text).slice(0, TRIGGER_PREVIEW)}`,
		"Its worker decides it. Act only if the person asks to stop the work.",
	].join("\n");
	return {
		id: `followup-${trigger.id}`,
		kind: "followup",
		at: trigger.at,
		ticketIds: [...ticketIds],
		triggerId: trigger.id,
		text: bound(text, { ticket: ticketIds[0] }),
	};
}

/** A Source, the effect queue or a pass failed often enough to need a person. */
export function problemMessage(problem: { code: string; message: string; at?: number; count?: number }): RouterMessage {
	const at = problem.at ?? Date.now();
	const count = problem.count ?? 1;
	const text = `Problem ${problem.code} (${count} in a row): ${collapse(problem.message)} Check the panel and the host log.`;
	return { id: `problem-${problem.code}-${at}`, kind: "problem", at, text: bound(text) };
}

// ---------------------------------------------------------------- helpers

type BoundTarget = { ticket?: TicketId | undefined; candidate?: string };

/** Collapse whitespace and cap the text, keeping the pointer that names where the rest lives. */
export function bound(text: string, target: BoundTarget = {}): string {
	const pointer = target.ticket === undefined ? "" : ` (see ticket ${target.ticket})`;
	const room = MESSAGE_LIMIT - pointer.length;
	const flat = collapse(text);
	return `${flat.length <= room ? flat : `${flat.slice(0, Math.max(0, room - 1))}…`}${pointer}`;
}

export function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function isTrigger(value: Trigger | undefined): value is Trigger {
	return value !== undefined;
}

function isTicket(value: Ticket | undefined): value is Ticket {
	return value !== undefined;
}
