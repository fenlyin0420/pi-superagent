import { describe, expect, it } from "vitest";
import type { Actor, Policy, PolicyRule, Trigger } from "../src/core/model.js";
import { changedRules, createPolicyGate, matchedRuleIds, policyEffects, policyEffectText } from "../src/policy.js";
import { makePolicy, makeTicket, makeTrigger } from "../src/testing/fakes.js";

const RULE: PolicyRule = {
	id: "flaky",
	text: "Repair flaky tests and their upload path",
	scope: "tests only",
	strength: "inferred",
};

function policy(patch: Partial<Policy> = {}): Policy {
	return makePolicy({
		acceptMode: "explicit",
		rules: [RULE],
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

const gateOf = (current: Policy, self?: Record<string, Actor | undefined>) =>
	createPolicyGate(self ? { policy: () => current, self: () => self } : { policy: () => current });

describe("gate", () => {
	it("refuses a Source that is off or names no repository", () => {
		const off = policy({ sources: { github: { ...policy().sources.github!, enabled: false } } });
		expect(gateOf(off).gate(makeTrigger()).refusal?.code).toBe("source_disabled");
		const unnamed = policy({ sources: { github: { ...policy().sources.github!, repository: "  " } } });
		expect(gateOf(unnamed).gate(makeTrigger()).refusal?.code).toBe("source_disabled");
	});

	it("refuses bots, listed bot identities and the agent itself", () => {
		const current = policy();
		const bot: Trigger = makeTrigger({ actor: { id: "renovate", bot: true } });
		expect(gateOf(current).gate(bot).refusal?.code).toBe("bot_actor");
		const listed: Trigger = makeTrigger({ actor: { id: "dependabot[bot]", bot: false } });
		expect(gateOf(current).gate(listed).refusal?.code).toBe("bot_actor");
		const mine: Trigger = makeTrigger({ actor: { id: "sagent", bot: false } });
		const self = { github: { id: "sagent", bot: false } };
		expect(gateOf(current, self).gate(mine).refusal?.code).toBe("bot_actor");
	});

	it("refuses a sender the Source does not list", () => {
		const result = gateOf(policy()).gate(makeTrigger({ actor: { id: "mallory", bot: false } }));
		expect(result).toMatchObject({ admissible: false, refusal: { code: "not_a_member" } });
	});

	it("refuses everything in `off` mode, and inferred work in `explicit` mode", () => {
		expect(gateOf(policy({ acceptMode: "off" })).gate(makeTrigger({ kind: "mention" })).refusal?.code).toBe("not_allowed");
		expect(gateOf(policy({ acceptMode: "explicit" })).gate(makeTrigger()).refusal?.code).toBe("not_allowed");
		expect(gateOf(policy({ acceptMode: "inferred" })).gate(makeTrigger())).toMatchObject({
			admissible: true,
			strength: "inferred",
		});
	});

	it("admits a direct request as explicit in every mode that admits it", () => {
		for (const kind of ["mention", "assignment", "review_request"]) {
			const result = gateOf(policy({ acceptMode: "explicit" })).gate(makeTrigger({ kind }));
			expect(result).toMatchObject({ admissible: true, strength: "explicit" });
		}
	});

	it("treats a message that names the agent's handle as a direct request", () => {
		const self = { github: { id: "sagent", bot: false } };
		const trigger = makeTrigger({ kind: "issue_opened", text: "hey @sagent can you bump the cache key?" });
		expect(gateOf(policy({ acceptMode: "explicit" }), self).gate(trigger)).toMatchObject({
			admissible: true,
			strength: "explicit",
		});
		const unaddressed = makeTrigger({ kind: "issue_opened", text: "cache key looks stale" });
		expect(gateOf(policy({ acceptMode: "explicit" }), self).gate(unaddressed).refusal?.code).toBe("not_allowed");
	});

	it("matches the rules whose id or text words the message touches", () => {
		const other: PolicyRule = { id: "docs", text: "Rewrite the release notes", scope: "docs", strength: "inferred" };
		const current = policy({ rules: [RULE, other] });
		expect(matchedRuleIds(current, "please fix the flaky upload")).toEqual(["flaky"]);
		expect(matchedRuleIds(current, "rewrite the release notes")).toEqual(["docs"]);
		expect(matchedRuleIds(current, "thanks")).toEqual([]);
		expect(gateOf(current).gate(makeTrigger({ text: "the flaky test is back" })).matchedRules).toEqual(["flaky"]);
	});
});

describe("policy changes", () => {
	const ticket = (matchedRules: string[]) =>
		makeTicket({
			mandate: {
				policyVersion: 1,
				scope: "fix the flaky upload test",
				strength: "inferred",
				matchedRules,
				requester: { id: "alice", bot: false },
				receivedAs: "issue_comment",
				triggerId: "trg-1",
				triggerIds: ["trg-1"],
			},
		});

	it("reports a rule the mandate relied on that changed or disappeared", () => {
		const from = policy();
		const rewritten = policy({ version: 2, rules: [{ ...RULE, text: "Repair flaky tests only" }] });
		expect(policyEffects(from, rewritten, ticket(["flaky"]))).toEqual(["rule_changed"]);
		expect(changedRules(from, rewritten, ticket(["flaky"]))).toHaveLength(1);
		const withdrawn = policy({ version: 2, rules: [] });
		expect(policyEffects(from, withdrawn, ticket(["flaky"]))).toEqual(["rule_changed"]);
		expect(policyEffects(from, policy({ version: 2 }), ticket(["flaky"]))).toEqual([]);
	});

	it("reports a requester who may no longer start work", () => {
		const from = policy();
		const narrowed = policy({
			version: 2,
			sources: { github: { ...from.sources.github!, allowedActors: ["bob"] } },
		});
		expect(policyEffects(from, narrowed, ticket([]))).toEqual(["requester_blocked"]);
		const off = policy({ version: 2, sources: { github: { ...from.sources.github!, enabled: false } } });
		expect(policyEffects(from, off, ticket([]))).toEqual(["requester_blocked"]);
	});

	it("reports that proactive work is no longer accepted", () => {
		const from = policy({ acceptMode: "inferred" });
		expect(policyEffects(from, policy({ version: 2, acceptMode: "explicit" }), ticket([]))).toEqual(["proactive_off"]);
		expect(policyEffects(from, policy({ version: 2, acceptMode: "off" }), ticket([]))).toEqual(["proactive_off"]);
	});

	it("leaves a ticket the change does not bear on alone", () => {
		expect(policyEffects(policy(), policy({ version: 2 }), ticket([]))).toEqual([]);
	});

	it("words the effect for the ticket's worker", () => {
		const from = policy({ acceptMode: "inferred" });
		const to = policy({ version: 2, acceptMode: "explicit", rules: [{ ...RULE, text: "Repair flaky tests only" }] });
		const codes = policyEffects(from, to, ticket(["flaky"]));
		const text = policyEffectText(from, to, ticket(["flaky"]), codes);
		expect(codes).toEqual(["rule_changed", "proactive_off"]);
		expect(text).toContain("Policy 1 → 2");
		expect(text).toContain("Repair flaky tests only");
		expect(text).toContain("proactive work is no longer accepted");
	});

	it("keeps the mandate of an explicit accept when only the mode tightens", () => {
		const explicit = { ...ticket([]), mandate: { ...ticket([]).mandate, strength: "explicit" as const } };
		expect(policyEffects(policy({ acceptMode: "inferred" }), policy({ version: 2, acceptMode: "explicit" }), explicit)).toEqual([]);
	});
});
