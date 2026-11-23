/**
 * The messages a Ticket writes to a Channel (docs 002-authorization.md under
 * "Routing candidates", and 003-execution.md under "Channel failure").
 *
 * Four purposes, each with its own rule for when it may go out. Every message
 * carries a stable id, so the outbox sends it once however often the same
 * request arrives.
 */
import type { SourceId, ThreadKey, Ticket, Trigger } from "./model.js";
import type { OutboundMessage, ReplyRequest } from "./ports.js";
import { DEFAULT_ACKNOWLEDGEMENT, EnginePart, UserError, latestReport, liveTicket, personInput } from "./part.js";

export class Replies extends EnginePart {
	/**
	 * 001: an accept tells the person who asked that the work started, where they
	 * asked for it. Bots and the agent's own events get no acknowledgement.
	 */
	accepted(ticket: Ticket, trigger: Trigger | undefined): void {
		if (trigger === undefined || trigger.actor.bot) return;
		const text = this.options.acknowledgement?.(ticket) ?? DEFAULT_ACKNOWLEDGEMENT;
		this.send({
			id: `ack-${trigger.id}`,
			source: ticket.source,
			channel: trigger.channel,
			thread: ticket.thread,
			purpose: "acknowledgement",
			ticketId: ticket.id,
			body: text,
			at: this.now(),
		});
	}

	/** Route a message for the Channel its purpose names, by that purpose's rule. */
	reply(request: ReplyRequest): void {
		const ticket = this.ticketOf(request);
		this.send(this.compose(request, ticket));
	}

	private compose(request: ReplyRequest, ticket: Ticket | undefined): OutboundMessage {
		const at = this.now();
		const base = {
			source: request.source,
			channel: request.channel,
			thread: request.thread,
			ticketId: ticket?.id ?? request.ticketId,
			body: request.body,
			at,
		};
		switch (request.purpose) {
			case "acknowledgement": {
				// 002: an acknowledgement answers a person's request on a Ticket still open for it.
				const open = this.requireTicket(ticket);
				if (!liveTicket(open)) throw new UserError("ackEnded");
				if (!open.subscriptions.includes(request.thread) && open.thread !== request.thread) throw new UserError("notReached");
				if (open.mandate.requester.bot) throw new UserError("ackNotPerson");
				return { ...base, id: `ack-${open.mandate.triggerId}`, purpose: "acknowledgement", ticketId: open.id };
			}
			case "answer": {
				// 003: an answer carries what the worker reported about a person's question.
				const open = this.requireTicket(ticket);
				if (!open.inputs.some((input) => personInput(this.state, input))) throw new UserError("answerNotAsked");
				const report = latestReport(open);
				if (report === undefined || report.kind === "progress") throw new UserError("noAnswer");
				return { ...base, id: `answer-${open.id}-${request.thread}`, purpose: "answer", ticketId: open.id };
			}
			case "result": {
				// 003: a result goes out once the work has one: a ready Report, or an end that carries it.
				const open = this.requireTicket(ticket);
				if (!hasResult(open)) throw new UserError("notReady");
				return { ...base, id: `result-${open.id}`, purpose: "result", ticketId: open.id };
			}
			case "attention": {
				// 003: the question a person must answer is the one the Ticket holds open now.
				const open = this.requireTicket(ticket);
				const attention = open.attention;
				if (attention === undefined || attention.answeredAt !== undefined) throw new UserError("notAttention");
				return { ...base, id: `attention-${open.id}-${attention.at}`, purpose: "attention", ticketId: open.id };
			}
		}
	}

	private requireTicket(ticket: Ticket | undefined): Ticket {
		if (ticket === undefined) throw new UserError("unknownTicket");
		return ticket;
	}

	private ticketOf(request: ReplyRequest): Ticket | undefined {
		if (request.ticketId !== undefined) return this.require(request.ticketId);
		return this.ticketOnThread(request.thread, request.source);
	}

	private ticketOnThread(thread: ThreadKey, source: SourceId): Ticket | undefined {
		const candidates = Object.values(this.state.tickets).filter((ticket) => ticket.thread === thread && ticket.source === source);
		return candidates.find((ticket) => liveTicket(ticket)) ?? candidates.at(-1);
	}

	private send(message: OutboundMessage): void {
		this.effect({ kind: "reply", message });
	}
}

/** 003: a ready Report, or an end that carries the result: completed, merged or dropped. */
function hasResult(ticket: Ticket): boolean {
	const ended = ticket.ended;
	if (ended !== undefined) return ended.outcome === "completed" || ended.outcome === "merged" || ended.outcome === "dropped";
	return latestReport(ticket)?.kind === "ready";
}
