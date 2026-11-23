/**
 * Trigger intake (docs/001-domain.md "Flow", docs/002-authorization.md "Two paths
 * for a Trigger").
 *
 * A Trigger is stored once, keyed by `(source, externalId)`. It fans out to the
 * live Tickets subscribed to its Threads; a person's message that reaches an
 * ended Ticket resumes it instead, and takes no Eval. Every other Trigger — a
 * bot's, a CI result, a person's message no Ticket owns — waits for the Thread's
 * next Eval.
 */
import type { ThreadKey, Ticket, TicketId, Trigger } from "./model.js";
import type { EngineOptions } from "./part.js";
import { EnginePart, stoppedTicket } from "./part.js";
import type { Tickets } from "./tickets.js";

export type ReceiveResult = "stored" | "duplicate" | "filtered";

export class Intake extends EnginePart {
	constructor(
		options: EngineOptions,
		private readonly tickets: Tickets,
	) {
		super(options);
	}

	receive(trigger: Trigger): ReceiveResult {
		if (!trigger.threads.length) throw new Error("A Trigger must belong to at least one Thread");
		const duplicate = Object.values(this.state.triggers).some(
			(stored) => stored.source === trigger.source && stored.externalId === trigger.externalId,
		);
		if (duplicate) return "duplicate";
		const at = this.now();
		this.state.triggers[trigger.id] = trigger;
		if (trigger.filtered !== undefined) {
			this.state.dispositions[trigger.id] = { triggerId: trigger.id, status: "filtered", at };
			return "filtered";
		}
		const source = this.policy().sources[trigger.source];
		const person = !trigger.actor.bot && !(source?.botActors ?? []).some((id) => same(id, trigger.actor.id));
		const reached: TicketId[] = [];
		for (const key of trigger.threads) {
			const record = this.thread(key, trigger.source);
			record.triggerIds.push(trigger.id);
			for (const other of [...trigger.threads, ...trigger.correlations]) {
				if (other !== key) record.correlations[other] = true;
			}
			for (const subscription of record.subscriptions) {
				if (subscription.dropped !== undefined) continue;
				const ticket = this.state.tickets[subscription.ticketId];
				// 002: a Ticket a person stopped receives nothing more.
				if (ticket === undefined || stoppedTicket(ticket)) continue;
				if (ticket.ended === undefined) {
					this.reach(ticket, trigger, "trigger", at);
					reached.push(ticket.id);
					continue;
				}
				// 001: only a person's message resumes an ended Ticket, and never on a Thread read for context only.
				if (!person || subscription.kind === "context") continue;
				this.reach(ticket, trigger, "resume", at);
				if (this.tickets.resume(ticket)) reached.push(ticket.id);
			}
		}
		// 002: a person's message that reached a Ticket stays with it; everything else takes the Eval path.
		const queued = person && reached.length > 0 ? undefined : this.enqueueTrigger(this.thread(trigger.threads[0] as ThreadKey, trigger.source), trigger.id);
		const dispositionAt = this.now();
		this.state.dispositions[trigger.id] = {
			triggerId: trigger.id,
			status: reached.length > 0 ? "fanned-out" : "evaluated",
			at: dispositionAt,
			...(reached[0] === undefined ? {} : { ticketId: reached[0] }),
			...(queued === undefined ? {} : { evalId: queued.id }),
		};
		this.emit({ type: "trigger.received", at: dispositionAt, triggerId: trigger.id, threads: trigger.threads });
		return "stored";
	}

	/** 003: the message reaches the Ticket as an Input, unless a person stopped it or the Thread lends no authority. */
	private reach(ticket: Ticket, trigger: Trigger, kind: "trigger" | "resume", at: number): void {
		this.tickets.addInput(ticket, {
			id: `in-${ticket.id}-${trigger.id}-${kind}`,
			ticketId: ticket.id,
			kind,
			text: trigger.text,
			triggerId: trigger.id,
			at,
		});
	}
}

function same(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}
