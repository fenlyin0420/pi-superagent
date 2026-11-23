/**
 * Evals: one batch of Triggers per Thread at a time, and the Decision each one
 * ends with (docs/001-domain.md "Eval", docs/002-authorization.md "When Eval does
 * not finish").
 *
 * A Thread's waiting Triggers live as one Eval of status `queued`; starting it
 * turns it `running` and hands the router session a Candidate. Its deadline
 * counts from the moment the Candidate reached the router session, never from
 * the batch: a Candidate nobody received never expires.
 */
import type { GateResult } from "./ports.js";
import type { Candidate, Decision, DecisionKind, Eval, EvalId, Reason, ThreadKey, ThreadRecord, Ticket, TicketId, Trigger, TriggerId } from "./model.js";
import { DEFAULT_EVAL_TIMEOUT_MS, EnginePart, type EngineOptions, UserError, latestReport, liveTicket, nextSeq } from "./part.js";
import type { Tickets } from "./tickets.js";

/** 002: how many times in a row an expired Eval queues its Triggers again before it is recorded unavailable. */
const REQUEUES = 2;

export class Evals extends EnginePart {
	constructor(
		options: EngineOptions,
		private readonly tickets: Tickets,
	) {
		super(options);
	}

	/** Start a Thread's batch: gate every Trigger, take the strongest, and ask the router session to decide. */
	start(thread: ThreadKey): void {
		const record = this.state.threads[thread];
		if (record === undefined || record.runningEvalId !== undefined) return;
		const batch = this.queuedEval(thread);
		if (batch === undefined) return;
		const at = this.now();
		const started = this.startedTriggers(record);
		const reasons: Reason[] = [];
		let strongest: { trigger: Trigger; gate: GateResult } | undefined;
		const admitted: Trigger[] = [];
		for (const triggerId of batch.triggerIds) {
			const trigger = this.state.triggers[triggerId];
			if (trigger === undefined) continue;
			// 001: a Trigger that already started a Ticket cannot start another.
			const ticketId = started.get(trigger.id);
			if (ticketId !== undefined) {
				reasons.push({ code: "startedTicket", values: { ticket: ticketId }, triggerId: trigger.id });
				continue;
			}
			const gate = this.options.policy.gate(trigger);
			if (!gate.admissible) {
				reasons.push({ code: gate.refusal?.code ?? "not_allowed", values: gate.refusal?.values, triggerId: trigger.id });
				continue;
			}
			admitted.push(trigger);
			if (strongest === undefined || this.stronger(gate, trigger, strongest)) strongest = { trigger, gate };
		}
		if (strongest === undefined) {
			this.record(`dec-${nextSeq(this.state, "decision")}`, record, batch, "ignore", reasons.length > 0 ? reasons : [{ code: "nothing_to_do" }], "assessment");
			return;
		}
		batch.triggerIds = admitted.map((trigger) => trigger.id);
		batch.status = "running";
		batch.startedAt = at;
		batch.primaryTriggerId ??= strongest.trigger.id;
		batch.strategy = strongest.gate.strength;
		batch.basis = basisOf(strongest.trigger, strongest.gate);
		record.runningEvalId = batch.id;
		for (const triggerId of batch.triggerIds) {
			this.state.dispositions[triggerId] = { triggerId, status: "evaluated", at, evalId: batch.id };
		}
		this.emit({ type: "eval.started", at, evalId: batch.id, thread: batch.thread, triggerIds: [...batch.triggerIds], strength: batch.strategy });
		const candidate = this.candidateOf(batch, strongest.gate, reasons);
		this.effect({
			kind: "relay",
			message: { id: `candidate-${batch.id}`, kind: "candidate", at, candidate, text: candidateText(candidate) },
		});
	}

	/** 002: an Eval past its deadline queues its Triggers again twice, then is recorded unavailable. */
	due(thread: ThreadKey): void {
		const record = this.state.threads[thread];
		if (record === undefined || record.runningEvalId === undefined) return;
		const batch = this.state.evals[record.runningEvalId];
		if (batch === undefined || batch.status !== "running") return;
		if (this.paused() || batch.deadline === undefined || this.now() < batch.deadline) return;
		if (batch.requeues < REQUEUES) {
			batch.requeues += 1;
			this.requeue(record, batch);
			for (const triggerId of batch.triggerIds) this.emit({ type: "trigger.requeued", at: this.now(), triggerId });
			return;
		}
		this.record(`dec-${nextSeq(this.state, "decision")}`, record, batch, "unavailable", [{ code: "timeout" }], "assessment");
	}

	/** 002: the deadline counts from the moment the Candidate reached the router session. */
	delivered(evalId: EvalId): void {
		const batch = this.state.evals[evalId];
		if (batch === undefined || batch.status !== "running" || batch.candidateDeliveredAt !== undefined) return;
		const at = this.now();
		batch.candidateDeliveredAt = at;
		batch.deadline = at + (this.options.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS);
	}

	/** The Candidate of the Eval in progress that holds a Trigger, as the router session reads it. */
	candidate(triggerId: TriggerId): Candidate | undefined {
		const batch = this.running(triggerId);
		if (batch === undefined) return undefined;
		const trigger = this.state.triggers[triggerId];
		const gate = trigger === undefined ? undefined : this.options.policy.gate(trigger);
		return this.candidateOf(batch, gate, []);
	}

	/**
	 * Record what the router session decided about the Eval that holds a Trigger.
	 * An accept creates the Ticket with its Mandate; a stop ends the Thread's live
	 * Ticket; a stop with none left, and an ignore, decide nothing.
	 */
	decide(triggerId: TriggerId, outcome: DecisionKind, basis?: string, scope?: string): string {
		const trigger = this.requireTrigger(triggerId);
		const policy = this.policy();
		let batch = this.running(triggerId);
		if (batch === undefined) {
			const waiting = this.evalHolding(triggerId);
			if (waiting?.status === "queued") {
				this.start(waiting.thread);
				batch = this.running(triggerId);
			}
		}
		const gate = this.options.policy.gate(trigger);
		const decisionId = `dec-${nextSeq(this.state, "decision")}`;
		// 002: a stop also goes through the gate when the message a Ticket owns holds no Eval.
		if (batch === undefined) {
			if (outcome !== "stop") throw new UserError("evalFinished");
			return this.direct(decisionId, trigger, gate.strength);
		}
		const record = this.thread(batch.thread, batch.source);
		const reasons: Reason[] = [];
		let kind: DecisionKind = outcome;
		let ticketId: TicketId | undefined;
		if (outcome === "accept") {
			if (!gate.admissible) throw new UserError("notAdmissible", { reason: gate.refusal?.code ?? "" });
			// 002: proactive acceptance needs at least one matched rule.
			if (batch.strategy !== "explicit" && gate.matchedRules.length === 0) throw new UserError("noRule");
			const primary = this.state.triggers[batch.primaryTriggerId ?? triggerId] ?? trigger;
			const triggers = batch.triggerIds.flatMap((id) => {
				const item = this.state.triggers[id];
				return item === undefined ? [] : [item];
			});
			const ticket = this.tickets.create({
				decisionId,
				primary,
				triggers,
				thread: batch.thread,
				scope: scope ?? basis ?? batch.basis ?? primary.text,
				strength: batch.strategy ?? gate.strength,
				matchedRules: gate.matchedRules,
				policyVersion: policy.version,
			});
			ticketId = ticket.id;
			reasons.push({ code: "routed", values: { ticket: ticket.id } });
		} else if (outcome === "stop") {
			const ticket = this.liveTicketOn(batch.thread);
			if (ticket === undefined) {
				kind = "ignore";
				reasons.push({ code: "nothing_to_do" });
			} else {
				this.tickets.stop(ticket.id, "stopped_by_person");
				ticketId = ticket.id;
				reasons.push({ code: "stopped_by_person" });
			}
		} else if (outcome === "ignore") {
			reasons.push({ code: "nothing_to_do" });
		} else {
			reasons.push({ code: "unavailable" });
		}
		return this.record(decisionId, record, batch, kind, reasons, "assessment", ticketId).id;
	}

	/** 002: a person may send a stranded Trigger to a fresh Eval. */
	reevaluate(triggerId: TriggerId): void {
		const trigger = this.requireTrigger(triggerId);
		if (this.evalHolding(triggerId) !== undefined) return;
		this.enqueueTrigger(this.thread(trigger.threads[0] ?? "", trigger.source), triggerId);
		this.emit({ type: "trigger.requeued", at: this.now(), triggerId });
	}

	/** 002: a Trigger routed to a Ticket by hand leaves the Eval that held it; a batch it emptied ends without a Decision. */
	withdraw(trigger: Trigger, ticketId: TicketId): void {
		const batch = this.evalHolding(trigger.id);
		if (batch === undefined) return;
		const running = batch.status === "running";
		const rest = batch.triggerIds.filter((id) => id !== trigger.id);
		if (rest.length > 0) {
			batch.triggerIds = rest;
			return;
		}
		const at = this.now();
		if (running) {
			batch.triggerIds = [trigger.id];
			const record = this.thread(batch.thread, batch.source);
			const routed: Reason[] = [{ code: "routed", values: { ticket: ticketId } }];
			this.record(`dec-${nextSeq(this.state, "decision")}`, record, batch, "ignore", routed, "assessment", ticketId);
		} else {
			batch.status = "done";
			delete this.state.threads[batch.thread]?.runningEvalId;
		}
		this.state.dispositions[trigger.id] = { triggerId: trigger.id, status: "fanned-out", at, ticketId, evalId: batch.id };
		this.emit({ type: "trigger.routed", at, triggerId: trigger.id, ticketId });
	}

	/** 002: a person dismisses the problem an unavailable Decision shows. */
	dismiss(decisionId: string): void {
		const decision = this.state.decisions[decisionId];
		if (decision === undefined || decision.kind !== "unavailable") throw new UserError("unknownDecision");
		decision.dismissedAt = this.now();
	}

	/** 002: a Policy change discards the Evals in progress and queues their Triggers under the new version. */
	policyChanged(): void {
		for (const batch of Object.values(this.state.evals)) {
			if (batch.status !== "running") continue;
			const record = this.thread(batch.thread, batch.source);
			this.record(`dec-${nextSeq(this.state, "decision")}`, record, batch, "unavailable", [{ code: "policyChanged" }], "policy");
			batch.requeues = 0;
			this.requeue(record, batch);
		}
	}

	// ------------------------------------------------------------- internals

	/** 002: a person's stop of the work on a message no Eval holds; one with no live Ticket decides nothing. */
	private direct(id: string, trigger: Trigger, strength: Decision["strength"]): string {
		const thread = this.thread(trigger.threads[0] ?? "", trigger.source);
		const reasons: Reason[] = [];
		let kind: DecisionKind = "stop";
		let ticketId: TicketId | undefined;
		const ticket = this.liveTicketOn(thread.key);
		if (trigger.actor.bot) {
			kind = "ignore";
			reasons.push({ code: "bot_actor" });
		} else if (ticket === undefined) {
			kind = "ignore";
			reasons.push({ code: "nothing_to_do" });
		} else {
			this.tickets.stop(ticket.id, "stopped_by_person");
			ticketId = ticket.id;
			reasons.push({ code: "stopped_by_person" });
		}
		const at = this.now();
		const decision: Decision = {
			id,
			source: trigger.source,
			thread: thread.key,
			triggerId: trigger.id,
			triggerIds: [trigger.id],
			kind,
			strength,
			reasons,
			at,
			by: "request",
		};
		if (ticketId !== undefined) decision.ticketId = ticketId;
		this.state.decisions[decision.id] = decision;
		thread.decisionIds.push(decision.id);
		this.state.dispositions[trigger.id] = { triggerId: trigger.id, status: "evaluated", at };
		this.emit({ type: "decision.recorded", at, decisionId: decision.id, kind, thread: thread.key });
		return decision.id;
	}

	private requeue(record: ThreadRecord, batch: Eval): void {
		batch.status = "queued";
		batch.queuedAt = this.now();
		delete batch.startedAt;
		delete batch.deadline;
		delete batch.candidateDeliveredAt;
		delete batch.decisionId;
		if (record.runningEvalId === batch.id) delete record.runningEvalId;
	}

	private record(
		id: string,
		record: ThreadRecord,
		batch: Eval,
		kind: DecisionKind,
		reasons: Reason[],
		by: Decision["by"],
		ticketId?: TicketId,
	): Decision {
		const at = this.now();
		const decision: Decision = {
			id,
			source: batch.source,
			thread: batch.thread,
			triggerId: batch.primaryTriggerId ?? batch.triggerIds[0] ?? "",
			triggerIds: [...batch.triggerIds],
			kind,
			strength: batch.strategy ?? "inferred",
			reasons,
			at,
			by,
		};
		if (ticketId !== undefined) decision.ticketId = ticketId;
		this.state.decisions[decision.id] = decision;
		batch.status = "done";
		batch.decisionId = decision.id;
		delete batch.deadline;
		if (record.runningEvalId === batch.id) delete record.runningEvalId;
		record.decisionIds.push(decision.id);
		for (const triggerId of batch.triggerIds) {
			this.state.dispositions[triggerId] = { triggerId, status: "evaluated", at, evalId: batch.id };
		}
		this.emit({ type: "decision.recorded", at, decisionId: decision.id, kind, thread: batch.thread });
		return decision;
	}

	/** 002: prefer an explicit request; between equals, the latest Trigger. */
	private stronger(gate: GateResult, trigger: Trigger, best: { trigger: Trigger; gate: GateResult }): boolean {
		if (gate.strength !== best.gate.strength) return gate.strength === "explicit";
		return trigger.at >= best.trigger.at;
	}

	private running(triggerId: TriggerId): Eval | undefined {
		const batch = this.evalHolding(triggerId);
		return batch?.status === "running" ? batch : undefined;
	}

	private startedTriggers(record: ThreadRecord): Map<TriggerId, TicketId> {
		const started = new Map<TriggerId, TicketId>();
		for (const decisionId of record.decisionIds) {
			const decision = this.state.decisions[decisionId];
			if (decision?.kind !== "accept" || decision.ticketId === undefined) continue;
			for (const triggerId of decision.triggerIds) if (!started.has(triggerId)) started.set(triggerId, decision.ticketId);
		}
		return started;
	}

	private liveTicketOn(thread: ThreadKey): Ticket | undefined {
		return Object.values(this.state.tickets).filter((ticket) => ticket.thread === thread && liveTicket(ticket)).at(-1);
	}

	private candidateOf(batch: Eval, gate: GateResult | undefined, reasons: Reason[]): Candidate {
		return {
			evalId: batch.id,
			thread: batch.thread,
			source: batch.source,
			triggerIds: [...batch.triggerIds],
			strategy: batch.strategy ?? gate?.strength ?? "inferred",
			basis: batch.basis ?? "",
			matchedRules: gate?.matchedRules ?? [],
			reason: reasons,
			tickets: Object.values(this.state.tickets)
				.filter((ticket) => ticket.thread === batch.thread)
				.map((ticket) => ({
					id: ticket.id,
					state: ticket.ended === undefined ? "open" : ticket.ended.outcome,
					text: `${ticket.mandate.scope} — ${lastReportText(ticket)}`,
				})),
		};
	}
}

function basisOf(trigger: Trigger, gate: GateResult): string {
	const rules = gate.matchedRules.length > 0 ? `; matched rules: ${gate.matchedRules.join(", ")}` : "";
	if (gate.strength === "explicit") return `direct request from ${trigger.actor.id} (${trigger.kind})`;
	return `proactive candidate from ${trigger.actor.id} (${trigger.kind})${rules}`;
}

function lastReportText(ticket: Ticket): string {
	const report = latestReport(ticket);
	return report === undefined ? "no report yet" : `${report.kind}: ${report.text}`;
}

function candidateText(candidate: Candidate): string {
	const lines = [
		`Thread ${candidate.thread} — ${candidate.strategy}`,
		`Basis: ${candidate.basis}`,
		...candidate.reason.map((reason) => `Refused ${reason.triggerId ?? "the batch"}: ${reason.code}`),
		...candidate.tickets.map((ticket) => `Ticket ${ticket.id} (${ticket.state}): ${ticket.text}`),
	];
	return lines.join("\n");
}
