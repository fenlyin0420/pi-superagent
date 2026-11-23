import { beforeEach, describe, expect, it } from "vitest";
import type { Eval, Policy, Trigger } from "../src/core/model.js";
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
}

function defaultPolicy(patch: Partial<Policy> = {}): Policy {
	return makePolicy({
		acceptMode: "explicit",
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
	};
}

const evals = (store: MemoryStore): Eval[] => Object.values(store.state.evals);

/** Let an Eval's candidate reach the router session, then run past its deadline. */
function expire(h: Harness, evalId: string): void {
	h.engine.candidateDelivered(evalId);
	h.tick(60_000);
	h.engine.evaluateDue();
}

describe("batching", () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	it("turns a Thread's queued Triggers into one running Eval with its strongest basis", () => {
		h = harness({ acceptMode: "inferred" });
		const direct = makeTrigger({ kind: "mention", threads: ["issue:4"], text: "please fix the flaky test" });
		const chat = makeTrigger({ kind: "issue_comment", threads: ["issue:4"], text: "same here" });
		h.engine.receive(direct);
		h.engine.receive(chat);
		h.engine.evaluateDue();
		const running = evals(h.store).find((item) => item.status === "running");
		expect(running?.triggerIds).toEqual([direct.id, chat.id]);
		expect(running?.primaryTriggerId).toBe(direct.id);
		expect(running?.strategy).toBe("explicit");
		expect(running?.basis).toContain("direct request from alice");
		expect(running?.candidateDeliveredAt).toBeUndefined();
		const candidate = h.effects.ofKind("relay")[0]?.message.candidate;
		expect(candidate?.thread).toBe("issue:4");
		expect(candidate?.reason).toEqual([]);
	});

	it("records a Decision with the refusals when nothing in the batch is admissible", () => {
		const bot = makeTrigger({ kind: "ci", actor: { id: "ci", bot: true } });
		h.engine.receive(bot);
		h.engine.evaluateDue();
		expect(evals(h.store).every((item) => item.status === "done")).toBe(true);
		const decision = Object.values(h.store.state.decisions)[0];
		expect(decision?.kind).toBe("ignore");
		expect(decision?.reasons.map((reason) => reason.code)).toEqual(["bot_actor"]);
		expect(h.effects.ofKind("relay")).toHaveLength(0);
	});

	it("never expires a candidate the router session did not receive", () => {
		const trigger = makeTrigger({ kind: "mention" });
		h.engine.receive(trigger);
		h.engine.evaluateDue();
		h.tick(10 * 60_000);
		h.engine.evaluateDue();
		expect(evals(h.store)[0]).toMatchObject({ status: "running", requeues: 0 });
		expect(Object.values(h.store.state.decisions)).toHaveLength(0);
	});
});

describe("an Eval past its deadline", () => {
	let h: Harness;
	let trigger: Trigger;

	beforeEach(() => {
		h = harness();
		trigger = makeTrigger({ kind: "mention", threads: ["issue:4"] });
		h.engine.receive(trigger);
		h.engine.evaluateDue();
	});

	it("requeues its Triggers twice, then records it unavailable", () => {
		const evalId = evals(h.store)[0]?.id as string;
		expire(h, evalId);
		expect(evals(h.store)[0]).toMatchObject({ status: "running", requeues: 1 });
		expire(h, evalId);
		expect(evals(h.store)[0]).toMatchObject({ status: "running", requeues: 2 });
		expire(h, evalId);

		const batch = evals(h.store)[0];
		expect(batch?.status).toBe("done");
		const decisions = Object.values(h.store.state.decisions);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({ kind: "unavailable", triggerIds: [trigger.id] });
		expect(decisions[0]?.reasons).toEqual([{ code: "timeout" }]);
		expect(h.effects.ofKind("relay")).toHaveLength(3);
		expect(h.events.filter((event) => event.type === "trigger.requeued")).toHaveLength(2);
	});

	it("takes a person's re-evaluation into a fresh Eval", () => {
		const evalId = evals(h.store)[0]?.id as string;
		expire(h, evalId);
		expire(h, evalId);
		expire(h, evalId);
		h.effects.clear();
		h.engine.reevaluate(trigger.id);
		h.engine.evaluateDue();
		expect(evals(h.store).filter((item) => item.status === "running")).toHaveLength(1);
		expect(h.effects.ofKind("relay")).toHaveLength(1);
	});

	it("lets a person dismiss the problem an unavailable Decision shows", () => {
		const evalId = evals(h.store)[0]?.id as string;
		expire(h, evalId);
		expire(h, evalId);
		expire(h, evalId);
		const decision = Object.values(h.store.state.decisions)[0];
		h.engine.dismiss(decision?.id as string);
		expect(h.store.state.decisions[decision?.id as string]?.dismissedAt).toBe(190_000);
		h.engine.reevaluate(trigger.id);
		h.engine.evaluateDue();
		h.engine.decide(trigger.id, "accept", "asked", "fix it");
		const accepted = Object.values(h.store.state.decisions).find((item) => item.kind === "accept");
		expect(() => h.engine.dismiss(accepted?.id as string)).toThrow(/Unknown decision/);
	});
});

describe("deciding", () => {
	it("creates one ticket per Eval and refuses a decision on a settled one", () => {
		const h = harness();
		const trigger = makeTrigger({ kind: "mention", threads: ["issue:4"] });
		h.engine.receive(trigger);
		h.engine.evaluateDue();
		h.engine.decide(trigger.id, "accept", "asked directly", "fix it");
		expect(Object.values(h.store.state.tickets)).toHaveLength(1);
		expect(() => h.engine.decide(trigger.id, "accept")).toThrow(/eval has finished/);
	});

	it("ends the Thread's live ticket on a stop, and ignores a stop with none", () => {
		const h = harness();
		const first = makeTrigger({ kind: "mention", threads: ["issue:5"] });
		h.engine.receive(first);
		h.engine.evaluateDue();
		h.engine.decide(first.id, "accept", "asked", "fix it");
		const ticket = Object.values(h.store.state.tickets)[0];
		h.effects.clear();

		const stop = makeTrigger({ kind: "mention", threads: ["issue:5"], text: "stop, not needed" });
		h.engine.receive(stop);
		h.engine.evaluateDue();
		const decisionId = h.engine.decide(stop.id, "stop", "person asked to stop");
		expect(h.store.state.decisions[decisionId]).toMatchObject({ kind: "stop", ticketId: ticket?.id });
		expect(ticket?.ended).toMatchObject({ by: "person", outcome: "stopped" });

		const later = makeTrigger({ kind: "mention", threads: ["issue:6"] });
		h.engine.receive(later);
		h.engine.evaluateDue();
		const ignoredId = h.engine.decide(later.id, "stop");
		expect(h.store.state.decisions[ignoredId]?.kind).toBe("ignore");
	});

	it("records unavailable when the router session cannot judge", () => {
		const h = harness();
		const trigger = makeTrigger({ kind: "mention" });
		h.engine.receive(trigger);
		h.engine.evaluateDue();
		const id = h.engine.decide(trigger.id, "unavailable", "the model failed");
		expect(h.store.state.decisions[id]?.kind).toBe("unavailable");
	});

	it("hands the candidate the tickets already on the Thread", () => {
		const h = harness();
		const first = makeTrigger({ kind: "mention", threads: ["issue:5"] });
		h.engine.receive(first);
		h.engine.evaluateDue();
		h.engine.decide(first.id, "accept", "asked", "fix the flaky upload test");
		h.engine.stopTicket(Object.values(h.store.state.tickets)[0]?.id as string, "not this one");
		const second = makeTrigger({ kind: "mention", threads: ["issue:5"], text: "and update the docs" });
		h.engine.receive(second);
		h.engine.evaluateDue();
		const candidate = h.effects.ofKind("relay").at(-1)?.message.candidate;
		expect(candidate?.tickets).toHaveLength(1);
		expect(candidate?.tickets[0]?.state).toBe("stopped");
	});
});
