import { beforeEach, describe, expect, it } from "vitest";
import type { Eval, Policy, Ticket, Trigger } from "../src/core/model.js";
import { createEngine } from "../src/core/engine.js";
import type { DomainEvent } from "../src/core/part.js";
import { createPolicyGate } from "../src/policy.js";
import { createInitialState } from "../src/infra/store.js";
import { MemoryStore, RecordingEffects, makePolicy, makeTrigger } from "../src/testing/fakes.js";

interface Harness {
	store: MemoryStore;
	effects: RecordingEffects;
	events: DomainEvent[];
	engine: ReturnType<typeof createEngine>;
	tick(ms: number): void;
	setPolicy(policy: Policy): void;
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
				botActors: ["dependabot[bot]"],
				watchAll: true,
				pollMs: 60_000,
			},
		},
		...patch,
	});
}

function harness(patch: Partial<Policy> = {}): Harness {
	const store = new MemoryStore(createInitialState());
	store.state.policy = defaultPolicy(patch);
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
		setPolicy: (policy) => {
			store.state.policy = policy;
		},
	};
}

const tickets = (store: MemoryStore): Ticket[] => Object.values(store.state.tickets);
const evals = (store: MemoryStore): Eval[] => Object.values(store.state.evals);

/** Receive a Trigger, run the pass, and take the candidate it relays. */
function candidateOf(h: Harness, trigger: Trigger): { evalId: string; candidate: unknown } {
	h.engine.receive(trigger);
	h.engine.evaluateDue();
	const relay = h.effects.ofKind("relay").at(-1);
	expect(relay?.message.kind).toBe("candidate");
	if (relay?.message.candidate === undefined) throw new Error("no candidate");
	h.effects.clear();
	return { evalId: relay.message.candidate.evalId, candidate: relay.message.candidate };
}

describe("intake", () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	it("stores a Trigger once, keyed by (source, externalId)", () => {
		const trigger = makeTrigger({ externalId: "comment-1" });
		expect(h.engine.receive(trigger)).toBe("stored");
		const again = makeTrigger({ externalId: "comment-1" });
		expect(h.engine.receive(again)).toBe("duplicate");
		expect(Object.keys(h.store.state.triggers)).toEqual([trigger.id]);
		expect(evals(h.store)).toHaveLength(1);
	});

	it("records a Trigger a Source filtered and does nothing else", () => {
		const trigger = makeTrigger({ filtered: { code: "own_event" } });
		expect(h.engine.receive(trigger)).toBe("filtered");
		expect(h.store.state.dispositions[trigger.id]).toMatchObject({ status: "filtered" });
		expect(evals(h.store)).toHaveLength(0);
	});

	it("batches a Thread's Triggers into one Eval", () => {
		const first = makeTrigger({ kind: "mention", threads: ["issue:7"] });
		const second = makeTrigger({ kind: "mention", threads: ["issue:7"] });
		h.engine.receive(first);
		h.engine.receive(second);
		h.engine.evaluateDue();
		const running = evals(h.store).filter((item) => item.status === "running");
		expect(running).toHaveLength(1);
		expect(running[0]?.triggerIds).toEqual([first.id, second.id]);
		expect(running[0]?.strategy).toBe("explicit");
		expect(h.effects.ofKind("relay")).toHaveLength(1);
	});

	it("starts one Eval per Thread", () => {
		h.engine.receive(makeTrigger({ kind: "mention", threads: ["issue:7"] }));
		h.engine.receive(makeTrigger({ kind: "mention", threads: ["issue:8"] }));
		h.engine.evaluateDue();
		expect(evals(h.store).filter((item) => item.status === "running")).toHaveLength(2);
		expect(h.effects.ofKind("relay")).toHaveLength(2);
	});
});

describe("fan-out and resume", () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	function accepted(): Ticket {
		const trigger = makeTrigger({ kind: "mention", threads: ["issue:7"] });
		candidateOf(h, trigger);
		h.engine.decide(trigger.id, "accept", "asked directly", "fix the flaky upload test");
		h.effects.clear();
		const ticket = tickets(h.store)[0];
		if (ticket === undefined) throw new Error("no ticket was created");
		return ticket;
	}

	it("fans a person's message out to a live Ticket and takes no Eval", () => {
		const ticket = accepted();
		const followUp = makeTrigger({ threads: ["issue:7"], text: "any update?" });
		h.engine.receive(followUp);
		expect(ticket.inputs.some((input) => input.triggerId === followUp.id && input.kind === "trigger")).toBe(true);
		expect(h.store.state.dispositions[followUp.id]).toMatchObject({ status: "fanned-out", ticketId: ticket.id });
		h.engine.evaluateDue();
		expect(evals(h.store).filter((item) => item.status === "queued")).toHaveLength(0);
	});

	it("resumes an ended Ticket under its mandate instead of evaluating", () => {
		const ticket = accepted();
		const running = ticket.assignmentIds.at(-1) as string;
		h.engine.assignmentStarted(ticket.id, running);
		h.engine.report(ticket.id, running, { kind: "ready", text: "the upload test passes" });
		expect(ticket.ended?.outcome).toBe("completed");
		h.effects.clear();
		const message = makeTrigger({ threads: ["issue:7"], text: "it broke again" });
		h.engine.receive(message);
		expect(ticket.ended).toBeUndefined();
		expect(ticket.inputs.some((input) => input.triggerId === message.id && input.kind === "resume")).toBe(true);
		expect(ticket.assignmentIds).toHaveLength(2);
		expect(h.effects.ofKind("launch")).toHaveLength(1);
		h.engine.evaluateDue();
		expect(evals(h.store).filter((item) => item.status === "queued")).toHaveLength(0);
	});

	it("gives a bot's message to the live Ticket and to Eval", () => {
		const ticket = accepted();
		const ci = makeTrigger({ threads: ["issue:7"], kind: "ci", actor: { id: "ci", bot: true } });
		h.engine.receive(ci);
		expect(ticket.inputs.some((input) => input.triggerId === ci.id)).toBe(true);
		expect(h.store.state.dispositions[ci.id]?.evalId).toBeDefined();
	});

	it("neither resumes nor fans out to a Ticket a person stopped", () => {
		const ticket = accepted();
		h.engine.stopTicket(ticket.id, "not wanted");
		expect(ticket.ended).toMatchObject({ by: "person", outcome: "stopped" });
		const message = makeTrigger({ threads: ["issue:7"] });
		h.engine.receive(message);
		expect(ticket.ended?.outcome).toBe("stopped");
		expect(ticket.inputs.some((input) => input.triggerId === message.id)).toBe(false);
		expect(h.store.state.dispositions[message.id]?.evalId).toBeDefined();
	});
});

describe("accept to launch to report to end", () => {
	it("carries a whole piece of work through", () => {
		const h = harness();
		const trigger = makeTrigger({ kind: "mention", threads: ["issue:7"], text: "the flaky upload test needs fixing" });
		h.engine.receive(trigger);
		h.engine.evaluateDue();

		const relay = h.effects.ofKind("relay")[0];
		const candidate = relay?.message.candidate;
		expect(candidate?.strategy).toBe("explicit");
		expect(candidate?.matchedRules).toEqual(["flaky"]);
		h.engine.candidateDelivered(candidate?.evalId as string);
		const running = evals(h.store)[0];
		expect(running?.candidateDeliveredAt).toBe(10_000);
		expect(running?.deadline).toBe(70_000);

		const decisionId = h.engine.decide(trigger.id, "accept", "asked directly", "fix the flaky upload test");
		const decision = h.store.state.decisions[decisionId];
		expect(decision).toMatchObject({ kind: "accept", strength: "explicit" });

		const ticket = tickets(h.store)[0];
		expect(ticket).toMatchObject({ source: "github", thread: "issue:7" });
		expect(ticket?.mandate).toMatchObject({
			policyVersion: 1,
			scope: "fix the flaky upload test",
			strength: "explicit",
			matchedRules: ["flaky"],
			requester: { id: "alice", bot: false },
			receivedAs: "mention",
		});
		expect(ticket?.execution.name).toBe("fix-the-flaky-upload-test");
		expect(ticket?.assignmentIds).toHaveLength(1);
		expect(h.store.state.threads["issue:7"]?.subscriptions).toEqual([
			{ ticketId: ticket?.id, kind: "origin", at: 10_000 },
		]);

		expect(h.effects.ofKind("prepare")).toHaveLength(1);
		const launch = h.effects.ofKind("launch")[0];
		expect(launch?.ticketId).toBe(ticket?.id);
		const acknowledgement = h.effects.ofKind("reply")[0];
		expect(acknowledgement?.message).toMatchObject({ purpose: "acknowledgement", ticketId: ticket?.id });

		const assignmentId = ticket?.assignmentIds[0] as string;
		h.engine.assignmentStarted(ticket?.id as string, assignmentId);
		expect(ticket?.execution.assignmentId).toBe(assignmentId);
		expect(h.store.state.assignments[assignmentId]).toMatchObject({ state: "running", preparedAt: 10_000 });

		h.engine.report(ticket?.id as string, assignmentId, { kind: "ready", text: "the test passes now" });
		expect(ticket?.ended).toMatchObject({ by: "executor", outcome: "completed" });
		expect(h.store.state.assignments[assignmentId]?.state).toBe("ended");
		expect(h.effects.ofKind("endAssignment")).toHaveLength(1);
		expect(h.events.map((event) => event.type)).toContain("ticket.ended");
	});

	it("refuses an unknown accept and a second decision on one Eval", () => {
		const h = harness();
		const trigger = makeTrigger({ kind: "mention" });
		candidateOf(h, trigger);
		expect(() => h.engine.decide(trigger.id, "accept")).not.toThrow();
		expect(() => h.engine.decide(trigger.id, "accept")).toThrow(/eval has finished/);
		expect(() => h.engine.decide("trg-unknown", "ignore")).toThrow(/Unknown trigger/);
	});

	it("refuses a proactive accept with no matched rule", () => {
		const h = harness({ acceptMode: "inferred" });
		const trigger = makeTrigger({ kind: "issue_comment", text: "thanks, looks good" });
		candidateOf(h, trigger);
		expect(() => h.engine.decide(trigger.id, "accept", "nothing to go on")).toThrow(/matched rule/);
		h.engine.decide(trigger.id, "ignore", "plain chat");
		expect(tickets(h.store)).toHaveLength(0);
	});
});

describe("a paused pass", () => {
	it("expires nothing, then shifts the deadline by the pause's length", () => {
		const h = harness();
		const trigger = makeTrigger({ kind: "mention" });
		const candidate = candidateOf(h, trigger);
		h.engine.candidateDelivered(candidate.evalId);
		const batch = evals(h.store)[0];
		expect(batch?.deadline).toBe(70_000);

		h.tick(30_000);
		h.engine.pause();
		h.tick(40_000);
		h.engine.evaluateDue();
		expect(evals(h.store)[0]).toMatchObject({ status: "running", deadline: 70_000 });

		h.engine.resume();
		expect(evals(h.store)[0]?.deadline).toBe(110_000);
		h.engine.evaluateDue();
		expect(evals(h.store)[0]?.status).toBe("running");

		h.tick(50_000);
		h.engine.evaluateDue();
		expect(evals(h.store)[0]).toMatchObject({ status: "running", requeues: 1 });
	});

	it("holds an ended ticket's resume until the pass after the pause", () => {
		const h = harness();
		const trigger = makeTrigger({ kind: "mention", threads: ["issue:7"] });
		candidateOf(h, trigger);
		h.engine.decide(trigger.id, "accept");
		const ticket = tickets(h.store)[0];
		const assignmentId = ticket?.assignmentIds[0] as string;
		h.engine.assignmentStarted(ticket?.id as string, assignmentId);
		h.engine.report(ticket?.id as string, assignmentId, { kind: "ready", text: "done" });
		h.effects.clear();

		h.engine.pause();
		h.engine.receive(makeTrigger({ threads: ["issue:7"], text: "one more thing" }));
		expect(ticket?.resumePending).toBe(true);
		expect(ticket?.ended).toBeDefined();
		h.engine.evaluateDue();
		expect(ticket?.ended).toBeDefined();

		h.engine.resume();
		h.engine.evaluateDue();
		expect(ticket?.ended).toBeUndefined();
		expect(ticket?.assignmentIds).toHaveLength(2);
	});
});

describe("policy changes", () => {
	it("tells a live ticket how the change bears on it and restarts the evals in progress", () => {
		const h = harness();
		const trigger = makeTrigger({ kind: "mention", threads: ["issue:7"], text: "fix the flaky upload test" });
		candidateOf(h, trigger);
		h.engine.decide(trigger.id, "accept", "asked", "fix the flaky upload test");
		const ticket = tickets(h.store)[0];
		h.engine.assignmentStarted(ticket?.id as string, ticket?.assignmentIds[0] as string);
		h.effects.clear();

		const from = h.store.state.policy;
		const to = defaultPolicy({
			version: 2,
			rules: [{ id: "flaky", text: "Repair flaky tests only", scope: "tests", strength: "inferred" }],
		});
		h.setPolicy(to);
		h.engine.policyChanged(from, to);
		const notice = ticket?.inputs.find((input) => input.kind === "policy");
		expect(notice?.text).toContain("Repair flaky tests only");
		expect(h.effects.ofKind("deliver").flatMap((effect) => effect.inputIds)).toContain(notice?.id);
		expect(h.events.at(-1)?.type).toBe("policy.changed");

		const other = makeTrigger({ kind: "mention", threads: ["issue:9"] });
		h.engine.receive(other);
		h.engine.evaluateDue();
		expect(evals(h.store).some((item) => item.status === "running" && item.thread === "issue:9")).toBe(true);
		h.effects.clear();
		h.engine.policyChanged(to, defaultPolicy({ version: 3 }));
		expect(evals(h.store).filter((item) => item.status === "queued")).toHaveLength(1);
		expect(Object.values(h.store.state.decisions).some((item) => item.kind === "unavailable")).toBe(true);
	});
});
