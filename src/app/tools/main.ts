/**
 * The router session's tools (docs/000-design.md "Router tools").
 *
 * The host Pi session is the router: a candidate card arrives in its context and
 * it answers with one of these tools. Every tool is a thin call into the
 * runtime, so the same checks, the same state and the same effects run whether
 * the command came from the router, the panel or `pi-superagent`.
 *
 * Results are one compact line plus details: the router reads cards, not logs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Policy, SourceId } from "../../core/model.js";
import type { ReplyRequest } from "../../core/ports.js";
import type { Failure, Runtime } from "../runtime.js";

const DECISION_OUTCOMES = ["accept", "stop", "ignore", "unavailable"] as const;
const REPLY_PURPOSES = ["acknowledgement", "answer", "result", "attention"] as const;
const UNREAD_LIMIT = 50;
const UNREAD_SHOWN = 10;
const TEXT_PREVIEW = 200;

/** Every tool this module registers, in prompt order. */
export const ROUTER_TOOL_NAMES: readonly string[] = [
	"sagent_decide",
	"sagent_attach",
	"sagent_note",
	"sagent_reply",
	"sagent_status",
	"sagent_retry",
	"sagent_stop",
	"sagent_unsubscribe",
	"sagent_unread",
];

/** Register the router's tools. Only the host session calls this: a client has no router. */
export function registerRouterTools(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerTool({
		name: "sagent_decide",
		label: "Decide a candidate",
		description:
			"Record what the router decided about the trigger batch a candidate card names. accept starts a ticket under a mandate, stop ends the work on the thread, ignore leaves the message unanswered. To route a message to a ticket that already exists, use sagent_attach instead. Give proactive accepts at least one matched rule, and the scope in the requester's own terms.",
		promptSnippet: "sagent_decide: record the decision on a candidate — accept, stop or ignore its eval",
		promptGuidelines: [
			"Use sagent_decide once for every candidate card, with the outcome the card and the rules call for; a proactive accept needs a matched rule and a scope taken from the request.",
			"Use sagent_decide with ignore when no person must act and no rule allows work, and with stop only when a person explicitly asks to stop the work on the thread.",
		],
		parameters: Type.Object({
			triggerId: Type.String({ description: "The trigger id the candidate card named as its primary trigger." }),
			outcome: StringEnum(DECISION_OUTCOMES, { description: "What to do with the trigger's eval." }),
			basis: Type.Optional(
				Type.String({ description: "One sentence on why this outcome follows from the trigger and the rules." }),
			),
			scope: Type.Optional(
				Type.String({ description: "For accept: the work the mandate allows, in the requester's own terms." }),
			),
		}),
		async execute(_toolCallId, params) {
			const outcome = oneOf(DECISION_OUTCOMES, params.outcome);
			if (outcome === undefined) {
				return failed(`sagent_decide needs one of ${DECISION_OUTCOMES.join(", ")} as its outcome`);
			}
			const result = await runtime.decide({
				triggerId: params.triggerId,
				outcome,
				basis: params.basis,
				scope: params.scope,
			});
			if (!result.ok) return refused(result);
			return answered(`Decided ${outcome} for ${params.triggerId} (${result.value.decisionId}).`, {
				ok: true,
				decisionId: result.value.decisionId,
				outcome,
			});
		},
	});

	pi.registerTool({
		name: "sagent_attach",
		label: "Attach a trigger to a ticket",
		description:
			"Route a person's message to a ticket that already exists, as an attached subscription. Use it only when the message points at that ticket's issue, pull request or recent change exactly; a similar topic is not enough. The ticket's worker decides the message.",
		promptSnippet: "sagent_attach: route a person's message to an existing ticket",
		promptGuidelines: [
			"Use sagent_attach when a candidate card really continues an open ticket: name that ticket and the trigger, and add a note only when the worker needs one sentence of context.",
			"Use sagent_attach rather than accepting new work when the message asks about a pull request or change a ticket already owns.",
		],
		parameters: Type.Object({
			ticketId: Type.String({ description: "The ticket the message belongs to, such as ticket-12." }),
			triggerId: Type.String({ description: "The trigger id of the person's message." }),
			note: Type.Optional(Type.String({ description: "One sentence the ticket's worker should read with the message." })),
		}),
		async execute(_toolCallId, params) {
			const result = await runtime.attach({
				ticketId: params.ticketId,
				triggerId: params.triggerId,
				note: params.note,
			});
			if (!result.ok) return refused(result);
			return answered(`Attached ${params.triggerId} to ${params.ticketId}.`, {
				ok: true,
				ticketId: params.ticketId,
				triggerId: params.triggerId,
			});
		},
	});

	pi.registerTool({
		name: "sagent_note",
		label: "Note on a ticket",
		description:
			"Record one fact on a ticket for its worker and for a person reading it later. A note grants nothing, asks nothing and wakes nobody; it is context, at most one hundred words.",
		promptSnippet: "sagent_note: record one fact another ticket's work needs",
		promptGuidelines: [
			"Use sagent_note only for a fact a worker needs and does not have, such as a decision the router made elsewhere; keep it to one or two sentences and never add requirements.",
		],
		parameters: Type.Object({
			ticketId: Type.String({ description: "The ticket to note on, such as ticket-12." }),
			text: Type.String({ description: "The fact to keep, at most one hundred words." }),
		}),
		async execute(_toolCallId, params) {
			const result = await runtime.note({ ticketId: params.ticketId, text: params.text });
			if (!result.ok) return refused(result);
			return answered(`Noted on ${params.ticketId}.`, { ok: true, ticketId: params.ticketId });
		},
	});

	pi.registerTool({
		name: "sagent_reply",
		label: "Reply on a thread",
		description:
			"Write one Markdown message where the request was written: an acknowledgement, an answer, a result or a question for a person. The body goes out as written through the Source's outbox; the router never answers a worker's question itself, it forwards it.",
		promptSnippet: "sagent_reply: post a result, an answer or a person's question on the request's thread",
		promptGuidelines: [
			"Use sagent_reply with purpose result when an idle ticket has a ready result a person asked for, and with purpose attention to forward a worker's question unchanged, in its own words.",
			"Use sagent_reply only on the issue or pull-request thread the request came from; name it as issue:12 or pr:31.",
		],
		parameters: Type.Object({
			thread: Type.String({ description: "The thread to write on, such as issue:12 or pr:31." }),
			purpose: StringEnum(REPLY_PURPOSES, { description: "What the message is for." }),
			body: Type.String({ description: "The Markdown body, sent as written." }),
		}),
		async execute(_toolCallId, params) {
			const purpose = oneOf(REPLY_PURPOSES, params.purpose);
			if (purpose === undefined) {
				return failed(`sagent_reply needs one of ${REPLY_PURPOSES.join(", ")} as its purpose`);
			}
			const thread = params.thread.trim();
			const rows = await runtime.rows();
			const ticket = rows.ok ? rows.value.find((row) => row.thread === thread) : undefined;
			const source: SourceId = ticket?.source ?? "github";
			const repository = repositoryOf(runtime.policy(), source);
			if (repository === "") {
				return failed(`sagent_reply cannot address ${thread}: the ${source} source has no repository configured`);
			}
			const conversation = conversationFor(thread, repository);
			if (conversation === undefined) {
				return failed(`sagent_reply needs an issue or pull-request thread such as issue:12 or pr:31; ${thread} has no conversation to write to`);
			}
			const request: ReplyRequest = {
				source,
				thread,
				channel: { conversation },
				purpose,
				body: params.body,
			};
			if (ticket !== undefined) request.ticketId = ticket.id;
			const result = await runtime.reply(request);
			if (!result.ok) return refused(result);
			return answered(`Message ${purpose} posted on ${thread}.`, {
				ok: true,
				thread,
				purpose,
				...(ticket === undefined ? {} : { ticketId: ticket.id }),
			});
		},
	});

	pi.registerTool({
		name: "sagent_status",
		label: "Read a ticket's state",
		description:
			"Read where a ticket stands: its stage, the scope its mandate allows, its thread, its latest report and any question it waits for a person to answer. It changes nothing.",
		promptSnippet: "sagent_status: read a ticket's stage, latest report and open question",
		promptGuidelines: [
			"Use sagent_status when a card or a notice leaves the ticket's current state unclear; it answers what the panel would show and never asks the worker for anything.",
		],
		parameters: Type.Object({
			ticketId: Type.String({ description: "The ticket to read, such as ticket-12." }),
		}),
		async execute(_toolCallId, params) {
			const result = await runtime.openTicket({ ticketId: params.ticketId });
			if (!result.ok) return refused(result);
			const detail = result.value;
			const report = detail.ticket.reports.at(-1);
			const lines = [
				`${detail.ticket.id} (${detail.ticket.name}): ${detail.label}.`,
				`Scope: ${detail.ticket.mandate.scope}`,
				`Thread ${detail.ticket.thread} on ${detail.ticket.source}.`,
				`Reports: ${detail.ticket.reports.length}. Assignment: ${detail.assignment?.state ?? "none"}.`,
			];
			if (report !== undefined) lines.push(`Last report (${report.kind}): ${collapse(report.text).slice(0, TEXT_PREVIEW)}`);
			if (detail.ticket.attention !== undefined) {
				const options = detail.ticket.attention.options ?? [];
				lines.push(
					`Question for a person: ${collapse(detail.ticket.attention.question)}${options.length === 0 ? "" : ` Options: ${options.join(" / ")}`}`,
				);
			}
			return answered(lines.join("\n"), {
				ok: true,
				ticketId: detail.ticket.id,
				stage: detail.stage.code,
				reports: detail.ticket.reports.length,
				attention: detail.ticket.attention?.question ?? null,
			});
		},
	});

	pi.registerTool({
		name: "sagent_retry",
		label: "Retry a ticket",
		description:
			"Restart a ticket that cannot go on by itself: a failed input delivery, or a blocked or failed report no person has answered. The ticket's mandate is unchanged.",
		promptSnippet: "sagent_retry: retry a failed delivery or an unanswered blocked ticket",
		promptGuidelines: [
			"Use sagent_retry when the ticket's failure is transient and a person asked for it to continue; a person's message resumes a blocked ticket by itself, so retry is for a delivery that never arrived.",
		],
		parameters: Type.Object({
			ticketId: Type.String({ description: "The ticket to retry, such as ticket-12." }),
		}),
		async execute(_toolCallId, params) {
			const result = await runtime.retry({ ticketId: params.ticketId });
			if (!result.ok) return refused(result);
			return answered(`Retry requested for ${params.ticketId}.`, { ok: true, ticketId: params.ticketId });
		},
	});

	pi.registerTool({
		name: "sagent_stop",
		label: "Stop a ticket",
		description:
			"End a ticket for good because a person asked for it. A stopped ticket never resumes and its mandate is withdrawn; give one sentence of reason from the person's own words.",
		promptSnippet: "sagent_stop: end a ticket a person asked to stop",
		promptGuidelines: [
			"Use sagent_stop only when a person explicitly stops the work, and never on the router's own judgement; the reason is the person's reason, not a plan.",
		],
		parameters: Type.Object({
			ticketId: Type.String({ description: "The ticket to stop, such as ticket-12." }),
			reason: Type.Optional(Type.String({ description: "One sentence in the person's words on why the work stops." })),
		}),
		async execute(_toolCallId, params) {
			const result = await runtime.stopTicket({ ticketId: params.ticketId, reason: params.reason });
			if (!result.ok) return refused(result);
			return answered(`Stopped ${params.ticketId}.`, { ok: true, ticketId: params.ticketId });
		},
	});

	pi.registerTool({
		name: "sagent_unsubscribe",
		label: "Drop a thread's subscriptions",
		description:
			"Remove every ticket's subscription on a thread, so its messages stop reaching work that is not about them. The thread a ticket started on and a ticket's own pull request stay subscribed, and the engine refuses those.",
		promptSnippet: "sagent_unsubscribe: drop the subscriptions on a thread that is not about the work",
		promptGuidelines: [
			"Use sagent_unsubscribe when a person says a thread is the wrong place, naming the thread as issue:12 or pr:31; the engine refuses the threads a ticket must keep.",
		],
		parameters: Type.Object({
			thread: Type.String({ description: "The thread to unsubscribe, such as issue:12 or pr:31." }),
		}),
		async execute(_toolCallId, params) {
			const result = await runtime.unsubscribe({ thread: params.thread });
			if (!result.ok) return refused(result);
			return answered(`Unsubscribed ${params.thread}.`, { ok: true, thread: params.thread });
		},
	});

	pi.registerTool({
		name: "sagent_unread",
		label: "List unread triggers",
		description:
			"List the triggers that reached the router and have no eval yet, oldest first among the newest fifty. It is how a router turn begins when no card arrived by itself.",
		promptSnippet: "sagent_unread: list the triggers that reached the router undecided",
		promptGuidelines: [
			"Use sagent_unread at the start of a turn to see what arrived since the last decision; decide each trigger with sagent_decide and leave the ones already evaluated alone.",
		],
		parameters: Type.Object({}),
		async execute() {
			const result = await runtime.triggers({ limit: UNREAD_LIMIT });
			if (!result.ok) return refused(result);
			const unread = result.value.filter((trigger) => trigger.status === "stored");
			if (unread.length === 0) return answered("No unread triggers.", { ok: true, count: 0, triggerIds: [] });
			const lines = unread
				.slice(0, UNREAD_SHOWN)
				.map((trigger) => `${trigger.id}  ${trigger.kind}  ${collapse(trigger.text).slice(0, TEXT_PREVIEW)}`);
			return answered(`${unread.length} unread trigger${unread.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, {
				ok: true,
				count: unread.length,
				triggerIds: unread.map((trigger) => trigger.id),
			});
		},
	});
}

// ------------------------------------------------------------------ helpers

type RouterToolResult = AgentToolResult<Record<string, unknown>>;

function answered(text: string, details: Record<string, unknown>): RouterToolResult {
	return { content: [{ type: "text", text }], details };
}

function failed(text: string): RouterToolResult {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

/** A failure the runtime reported as data: the model reads its sentence and its code. */
function refused(failure: Failure): RouterToolResult {
	const code = failure.code === undefined ? "" : ` [${failure.code}]`;
	return failed(`${failure.error}${code}`);
}

function repositoryOf(policy: Policy, source: SourceId): string {
	return policy.sources[source]?.repository.trim() ?? "";
}

/**
 * The GitHub conversation a thread writes to: `issue:12` on `owner/name` reads
 * `issue:owner/name#12`. A thread that names no issue or pull request has no
 * conversation, so a reply to it has nowhere to go.
 */
function conversationFor(thread: string, repository: string): string | undefined {
	const match = /^(issue|pr):(\d+)$/.exec(thread);
	const kind = match?.[1];
	const number = match?.[2];
	if (kind === undefined || number === undefined) return undefined;
	return `${kind}:${repository}#${number}`;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** A string the schema already constrained to `values`; the model-facing type is inferred separately. */
function oneOf<const T extends readonly string[]>(values: T, value: unknown): T[number] | undefined {
	if (typeof value !== "string" || !values.includes(value)) return undefined;
	return value as T[number];
}
