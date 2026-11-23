import { beforeEach, describe, expect, it } from "vitest";
import type { Policy, Ticket } from "../src/core/model.js";
import { createEngine } from "../src/core/engine.js";
import type { DomainEvent } from "../src/core/part.js";
import { ticketStage } from "../src/core/stage.js";
import { createPolicyGate } from "../src/policy.js";
import { createInitialState } from "../src/infra/store.js";
import { MemoryStore, RecordingEffects, makePolicy, makeTrigger } from "../src/testing/fakes.js";

interface Harness {
	store: MemoryStore;
	effects: RecordingEffects;
	events: DomainEvent[];
	engine: ReturnType<typeof createEngine>;
	tick(ms: number): void;
}

function defaultPolicy(patch: Partial<Policy> = {}): Policy {
	return makePolicy({
		acceptMode: "explicit",
		rules: [{ id: "flaky", text: "Repair flaky tests", scope: "tests", strength: "inferred" }],
		sources: {
			github: {
				enabled: true,
				repository: "owner/repo",
				allowedActors: ["alice"],
				botActors: [],
				watchAll: true,
				pollMs: 60_000,
			},
		},
		...patch,
	});
}

function harness(): Harness {
	const store = new MemoryStore(createInitialState());
	store.state.policy = defaultPolicy();
	const effects = new RecordingEffects();
	const events: DomainEvent[] = [];
	let clock = 10_000;
	const engine = createEngine({
		store,
		policy: createPolicyGate({ policy: () => store.state.policy }),
		effects,
		now: () => clock,
		emit: (event) => events.push(event),
		evalTimeoutMs: 60_000,
	});
	return {
		store,
		effects,
		events,
		engine,
		tick: (ms) => {
			clock += ms;
		},
	};
}

/** Accept a direct request and put its first Assignment to work. */
function accepted(h: Harness, thread = "issue:7"): Ticket {
	const trigger = makeTrigger({ kind: "mention", threads: [thread], text: "the flaky upload test needs fixing" });
	h.engine.receive(trigger);
	h.engine.evaluateDue();
	h.engine.decide(trigger.id, "accept", "asked directly", "fix the flaky upload test");
	const ticket = Object.values(h.store.state.tickets).at(-1);
	if (ticket === undefined) throw new Error("no ticket");
	h.engine.assignmentStarted(ticket.id, ticket.assignmentIds.at(-1) as string);
	h.effects.clear();
	return ticket;
}

const assignmentOf = (h: Harness, ticket: Ticket) => h.store.state.assignments[ticket.assignmentIds.at(-1) as string];
const stageOf = (h: Harness, ticket: Ticket) => ticketStage(ticket, assignmentOf(h, ticket));

describe("the stage follows the reports", () => {
	let h: Harness;
	let ticket: Ticket;

	beforeEach(() => {
		h = harness();
		ticket = accepted(h);
	});

	const report = (kind: "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped", text = "…") =>
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind, text });

	it("goes working, queued, idle, then review", () => {
		expect(stageOf(h, ticket)).toEqual({ kind: "working", code: "working" });
		report("progress");
		expect(stageOf(h, ticket)).toEqual({ kind: "working", code: "working" });
		report("waiting");
		expect(stageOf(h, ticket)).toEqual({ kind: "idle", code: "idle" });
		ticket.assignmentIds.push("asg-pending");
		h.store.state.assignments["asg-pending"] = {
			...assignmentOf(h, ticket),
			id: "asg-pending",
			state: "pending",
			startedAt: undefined,
		};
		expect(stageOf(h, ticket)).toEqual({ kind: "working", code: "queued" });
		ticket.assignmentIds.pop();
		h.effects.clear();
		report("ready");
		expect(stageOf(h, ticket)).toEqual({ kind: "person", code: "review" });
	});

	it("holds a blocked ticket for a person until they write", () => {
		report("blocked", "which branch?");
		expect(stageOf(h, ticket)).toEqual({ kind: "person", code: "blocked" });
		h.tick(1_000);
		const message = makeTrigger({ threads: ["issue:7"], text: "use main" });
		h.engine.receive(message);
		expect(stageOf(h, ticket)).toEqual({ kind: "working", code: "working" });
	});

	it("shows an open question as a person stage and clears it with an answer", () => {
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, {
			kind: "waiting",
			text: "need a decision",
			attention: { question: "Which branch should I target?", options: ["main", "release"] },
		});
		expect(stageOf(h, ticket)).toEqual({ kind: "person", code: "answer" });
		expect(ticket.attention?.options).toEqual(["main", "release"]);
		h.engine.answerAttention(ticket.id, "main");
		expect(ticket.attention).toBeUndefined();
		expect(ticket.reports.at(-1)?.attention).toMatchObject({ answeredAt: 10_000, answer: "main" });
		expect(ticket.inputs.at(-1)).toMatchObject({ kind: "note", text: "A person answered: main" });
		expect(h.effects.ofKind("deliver").at(-1)?.inputIds).toContain(ticket.inputs.at(-1)?.id);
	});

	it("keeps a question off a ready result", () => {
		expect(() =>
			h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, {
				kind: "ready",
				text: "done",
				attention: { question: "merge it?" },
			}),
		).toThrow(/cannot also be a ready result/);
	});

	it("takes no automatic input while a person must act", () => {
		report("failed", "the toolchain is missing");
		const ci = makeTrigger({ threads: ["issue:7"], kind: "ci", actor: { id: "ci", bot: true } });
		h.engine.receive(ci);
		expect(ticket.inputs.some((input) => input.triggerId === ci.id)).toBe(true);
		expect(h.effects.ofKind("deliver")).toHaveLength(0);
	});
});

describe("the end of a ticket", () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	it("ends completed on a ready report with no pull request", () => {
		const ticket = accepted(h);
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "ready", text: "done" });
		expect(ticket.ended).toMatchObject({ by: "executor", outcome: "completed" });
		expect(h.effects.ofKind("endAssignment")).toHaveLength(1);
	});

	it("waits for its own pull request, then ends merged", () => {
		const ticket = accepted(h);
		h.engine.bindThread(ticket.id, "pr:31", true);
		expect(ticket.follows).toEqual([{ thread: "pr:31", own: true }]);
		h.effects.clear();
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "ready", text: "the pull request is up" });
		expect(ticket.ended).toBeUndefined();
		expect(stageOf(h, ticket)).toEqual({ kind: "person", code: "review" });

		h.engine.threadClosed("pr:31", "merged", 20_000);
		expect(ticket.ended).toMatchObject({ by: "executor", outcome: "merged", at: 20_000, reason: "pull_merged" });
		expect(ticket.subscriptions).toContain("pr:31");
	});

	it("ends closed when the pull request closes unmerged", () => {
		const ticket = accepted(h);
		h.engine.bindThread(ticket.id, "pr:31", true);
		h.engine.threadClosed("pr:31", "closed", 20_000);
		expect(ticket.ended).toMatchObject({ outcome: "closed", reason: "pull_closed" });
	});

	it("waits for every thread it follows once it opened none", () => {
		const ticket = accepted(h);
		h.engine.bindThread(ticket.id, "pr:31", false);
		h.engine.bindThread(ticket.id, "pr:32", false);
		h.engine.threadClosed("pr:31", "merged", 20_000);
		expect(ticket.ended).toBeUndefined();
		h.engine.threadClosed("pr:32", "closed", 21_000);
		expect(ticket.ended).toMatchObject({ outcome: "closed" });
	});

	it("does not end on a close while the worker holds a person's follow-up", () => {
		const ticket = accepted(h);
		h.engine.bindThread(ticket.id, "pr:31", true);
		h.tick(1_000);
		const message = makeTrigger({ threads: ["issue:7"], text: "please also handle the retry" });
		h.engine.receive(message);
		h.engine.inputsRead(ticket.id, [ticket.inputs.find((input) => input.triggerId === message.id)?.id as string]);
		h.tick(1_000);
		h.engine.threadClosed("pr:31", "merged", 12_000);
		expect(ticket.ended).toBeUndefined();
		h.effects.clear();
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "ready", text: "done" });
		expect(ticket.ended).toMatchObject({ outcome: "merged" });
	});

	it("ends dropped with nothing for a person to act on", () => {
		const ticket = accepted(h);
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "dropped", text: "already fixed upstream" });
		expect(ticket.ended).toMatchObject({ by: "executor", outcome: "dropped" });
	});

	it("sends a person's unread message back to routing when it ends", () => {
		const ticket = accepted(h);
		const followUp = makeTrigger({ threads: ["issue:7"], text: "also update the changelog" });
		h.engine.receive(followUp);
		expect(h.store.state.dispositions[followUp.id]?.evalId).toBeUndefined();
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "dropped", text: "nothing to do" });
		expect(h.store.state.dispositions[followUp.id]?.evalId).toBeDefined();
	});

	it("keeps the message a stop ended the ticket on out of routing", () => {
		const ticket = accepted(h);
		const stop = makeTrigger({ threads: ["issue:7"], text: "stop, not needed" });
		h.engine.receive(stop);
		h.engine.decide(stop.id, "stop", "person asked");
		h.engine.evaluateDue();
		expect(ticket.ended).toMatchObject({ by: "person", outcome: "stopped" });
		expect(h.store.state.dispositions[stop.id]?.evalId).toBeUndefined();
		expect(Object.values(h.store.state.evals).filter((item) => item.status === "queued")).toHaveLength(0);
	});
});

describe("failure and recovery", () => {
	let h: Harness;
	let ticket: Ticket;

	beforeEach(() => {
		h = harness();
		ticket = accepted(h);
	});

	it("retries a failed ticket with a new assignment", () => {
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "failed", text: "the toolchain broke" });
		expect(() => h.engine.retryTicket(ticket.id)).not.toThrow();
		expect(ticket.assignmentIds).toHaveLength(2);
		expect(assignmentOf(h, ticket)).toMatchObject({ state: "pending" });
		expect(h.effects.ofKind("endAssignment")[0]?.reason).toBe("retried");
		expect(h.effects.ofKind("launch")).toHaveLength(1);
	});

	it("retries a failed delivery without a new report", () => {
		h.engine.deliveryFailed(ticket.id, ticket.assignmentIds.at(-1) as string, "session gone");
		expect(ticket.delivery?.error).toBe("session gone");
		h.engine.retryTicket(ticket.id);
		expect(ticket.delivery).toBeUndefined();
	});

	it("offers no retry while the worker has the person's message", () => {
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "blocked", text: "need a branch" });
		h.tick(1_000);
		h.engine.receive(makeTrigger({ threads: ["issue:7"], text: "use main" }));
		expect(() => h.engine.retryTicket(ticket.id)).toThrow(/Retry needs/);
	});

	it("restarts an assignment the host interrupted mid-turn with a recovery note", () => {
		h.engine.assignmentInterrupted(ticket.id, ticket.assignmentIds.at(-1) as string);
		expect(ticket.assignmentIds).toHaveLength(2);
		const recovery = ticket.inputs.find((input) => input.kind === "recovery");
		expect(recovery?.text).toContain("host restarted");
		expect(h.effects.ofKind("launch")).toHaveLength(1);
	});

	it("keeps an assignment that had reported since its last delivery", () => {
		h.engine.inputsDelivered(ticket.id, ticket.assignmentIds.at(-1) as string, [ticket.inputs[0]?.id as string]);
		h.tick(1_000);
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "waiting", text: "waiting for CI" });
		h.effects.clear();
		h.engine.assignmentInterrupted(ticket.id, ticket.assignmentIds.at(-1) as string);
		expect(ticket.assignmentIds).toHaveLength(1);
		expect(ticket.inputs.some((input) => input.kind === "recovery")).toBe(false);
	});

	it("gives a new assignment the messages the replaced one never read", () => {
		const message = makeTrigger({ threads: ["issue:7"], text: "one more thing" });
		h.engine.receive(message);
		const input = ticket.inputs.find((item) => item.triggerId === message.id);
		h.engine.inputsDelivered(ticket.id, ticket.assignmentIds.at(-1) as string, [input?.id as string]);
		expect(input?.deliveredAt).toBe(10_000);
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "failed", text: "broke" });
		h.engine.retryTicket(ticket.id);
		expect(input?.deliveredAt).toBeUndefined();
	});
});

describe("subscriptions", () => {
	let h: Harness;
	let ticket: Ticket;

	beforeEach(() => {
		h = harness();
		ticket = accepted(h);
	});

	it("attaches a thread and hands a message beyond the ticket back to routing", () => {
		const elsewhere = makeTrigger({ threads: ["issue:9"], text: "unrelated request" });
		h.engine.receive(elsewhere);
		h.engine.evaluateDue();
		h.effects.clear();
		h.engine.attach(ticket.id, elsewhere.id, "this is the same work");
		expect(ticket.subscriptions).toContain("issue:9");
		expect(ticket.inputs.some((input) => input.triggerId === elsewhere.id)).toBe(true);

		const followUp = makeTrigger({ threads: ["issue:9"], text: "while you are at it, refactor billing" });
		h.engine.receive(followUp);
		expect(h.engine.handback(ticket.id, followUp.id, "beyond this ticket's scope")).toBe(true);
		expect(h.store.state.threads["issue:9"]?.subscriptions.some((item) => item.ticketId === ticket.id)).toBe(true);
		expect(() => h.engine.handback(ticket.id, followUp.id, "again")).toThrow(/already/);
		h.engine.evaluateDue();
		expect(Object.values(h.store.state.evals).some((item) => item.triggerIds.includes(followUp.id))).toBe(true);
	});

	it("resumes an ended ticket when the router attaches a message to it", () => {
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "ready", text: "done" });
		expect(ticket.ended?.outcome).toBe("completed");
		const elsewhere = makeTrigger({ threads: ["issue:9"], text: "the same work again" });
		h.engine.receive(elsewhere);
		h.engine.evaluateDue();
		h.effects.clear();
		h.engine.attach(ticket.id, elsewhere.id, "same ticket");
		expect(ticket.ended).toBeUndefined();
		expect(ticket.assignmentIds).toHaveLength(2);
		expect(ticket.subscriptions).toContain("issue:9");
		expect(h.effects.ofKind("launch")).toHaveLength(1);
		expect(Object.values(h.store.state.evals).every((item) => item.status === "done")).toBe(true);
	});

	it("gives the worker a note and asks a waiting one for its status", () => {
		h.engine.note(ticket.id, "ticket-2 already rewrote this module");
		expect(ticket.notes.at(-1)).toMatchObject({ by: "router" });
		expect(h.effects.ofKind("deliver").at(-1)?.inputIds).toContain(ticket.inputs.at(-1)?.id);
		expect(h.engine.requestStatus(ticket.id)).toBe(false);
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "waiting", text: "idle" });
		expect(h.engine.requestStatus(ticket.id)).toBe(true);
		expect(ticket.inputs.at(-1)?.kind).toBe("status");
	});

	it("drops only its own subscription to a thread it finds unrelated", () => {
		h.engine.bindThread(ticket.id, "pr:31", false);
		expect(() => h.engine.markUnrelated(ticket.id, "issue:7", "not ours")).toThrow(/thread the ticket started on/);
		expect(() => h.engine.markUnrelated(ticket.id, "pr:31", "not ours")).toThrow(/the ticket's own/);

		const elsewhere = makeTrigger({ threads: ["issue:9"], text: "unrelated" });
		h.engine.receive(elsewhere);
		h.engine.evaluateDue();
		h.engine.attach(ticket.id, elsewhere.id);
		h.tick(1_000);
		const theirs = makeTrigger({ threads: ["issue:9"], text: "and fix billing" });
		h.engine.receive(theirs);
		h.engine.markUnrelated(ticket.id, "issue:9", "another ticket's work");
		expect(h.store.state.dispositions[theirs.id]?.evalId).toBeDefined();
		const subscription = h.store.state.threads["issue:9"]?.subscriptions.find((item) => item.ticketId === ticket.id);
		expect(subscription?.dropped?.reason).toBe("another ticket's work");
		expect(ticket.subscriptions).not.toContain("issue:9");
	});

	it("follows a thread for context without letting it resume the ticket", () => {
		h.engine.followForContext(ticket.id, "pr:44");
		const subscription = h.store.state.threads["pr:44"]?.subscriptions[0];
		expect(subscription?.kind).toBe("context");
		const context = makeTrigger({ threads: ["pr:44"], text: "related discussion" });
		h.engine.receive(context);
		expect(ticket.inputs.some((input) => input.triggerId === context.id)).toBe(true);
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "ready", text: "done" });
		expect(ticket.ended?.outcome).toBe("completed");
		const later = makeTrigger({ threads: ["pr:44"], text: "same again?" });
		h.engine.receive(later);
		expect(ticket.ended?.outcome).toBe("completed");
	});

	it("drops every subscription on a thread a person unsubscribes", () => {
		h.engine.bindThread(ticket.id, "pr:31", true);
		h.engine.unsubscribe("pr:31");
		expect(h.store.state.threads["pr:31"]?.subscriptions).toEqual([]);
		expect(ticket.follows).toEqual([]);
	});
});

describe("replies", () => {
	let h: Harness;
	let ticket: Ticket;

	beforeEach(() => {
		h = harness();
		ticket = accepted(h);
	});

	const request = (purpose: "acknowledgement" | "answer" | "result" | "attention", body = "hello") => ({
		source: "github",
		thread: "issue:7",
		channel: { conversation: "issue:owner/repo#7" },
		purpose,
		ticketId: ticket.id,
		body,
	});

	it("acknowledges a person's request and refuses once the ticket ended", () => {
		h.engine.reply(request("acknowledgement"));
		expect(h.effects.ofKind("reply")[0]?.message).toMatchObject({ purpose: "acknowledgement", id: `ack-${ticket.mandate.triggerId}` });
		h.engine.stopTicket(ticket.id, "not needed");
		expect(() => h.engine.reply(request("acknowledgement"))).toThrow(/ended/);
	});

	it("sends a result only once the work has one", () => {
		expect(() => h.engine.reply(request("result"))).toThrow(/no ready result/);
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "ready", text: "done" });
		h.engine.reply(request("result"));
		expect(h.effects.ofKind("reply")[0]?.message).toMatchObject({ purpose: "result", id: `result-${ticket.id}` });
	});

	it("sends an answer only once the worker reported one", () => {
		expect(() => h.engine.reply(request("answer"))).toThrow(/has not answered/);
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, { kind: "waiting", text: "the test was flaky" });
		h.engine.reply(request("answer"));
		expect(h.effects.ofKind("reply")[0]?.message.purpose).toBe("answer");
	});

	it("sends an attention message only for the question the ticket holds", () => {
		expect(() => h.engine.reply(request("attention"))).toThrow(/no open question/);
		h.engine.report(ticket.id, ticket.assignmentIds.at(-1) as string, {
			kind: "waiting",
			text: "need a decision",
			attention: { question: "Which branch?" },
		});
		h.engine.reply(request("attention", "Which branch?"));
		expect(h.effects.ofKind("reply")[0]?.message.purpose).toBe("attention");
	});
});
