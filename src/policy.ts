/**
 * The gate, and what a Policy change bears on live work (docs 002-authorization.md).
 *
 * The gate is deterministic and free of model calls: it decides whether a
 * Trigger may originate work, with what strength, and which Policy rules apply
 * to it. `matchedRules` uses one plain rule, documented at `matchedRuleIds`.
 *
 * `acceptMode` names the strongest basis the deployment accepts:
 * - `off`: nothing originates work;
 * - `explicit`: only a direct request to the agent;
 * - `inferred`: direct requests and proactive candidates.
 */
import type { Actor, Policy, PolicyRule, SourceId, SourcePolicy, Strength, Ticket, Trigger } from "./core/model.js";
import type { GateResult, PolicyPort } from "./core/ports.js";

export interface PolicyGateOptions {
	/** The live Policy; the runtime reads it from settings on every call. */
	policy: () => Policy;
	/** The agent's own identity on each Source; its events never originate work. */
	self?: () => Record<SourceId, Actor | undefined>;
}

/** Trigger kinds with which a Source records that a person addressed the agent. */
const DIRECT_KINDS: ReadonlySet<string> = new Set(["mention", "assignment", "review_request", "review_requested", "direct"]);

/** Words shorter than this are too common to identify a rule on their own. */
const MIN_WORD = 4;

export class PolicyGate implements PolicyPort {
	private readonly policyOf: () => Policy;
	private readonly selfOf?: () => Record<SourceId, Actor | undefined>;

	constructor(options: PolicyGateOptions) {
		this.policyOf = options.policy;
		this.selfOf = options.self;
	}

	current(): Policy {
		return this.policyOf();
	}

	/**
	 * Whether a Trigger may originate work on its Source, and at which strength.
	 * Refusals come in the order the deployment checks them: the Source is off,
	 * the sender is a bot or the agent, the sender is not on the allowed list, the
	 * accept mode does not admit that strength.
	 */
	gate(trigger: Trigger): GateResult {
		const policy = this.policyOf();
		const source = policy.sources[trigger.source];
		const strength = this.addressesAgent(trigger, this.self(trigger.source)) ? "explicit" : "inferred";
		if (source === undefined || !source.enabled || source.repository.trim() === "") {
			return { admissible: false, strength, refusal: { code: "source_disabled" }, matchedRules: [] };
		}
		if (isBot(source, trigger.actor) || sameActor(this.self(trigger.source), trigger.actor)) {
			return { admissible: false, strength, refusal: { code: "bot_actor" }, matchedRules: [] };
		}
		const matchedRules = matchedRuleIds(policy, trigger.text);
		if (!allowed(source, trigger.actor)) {
			return { admissible: false, strength, refusal: { code: "not_a_member" }, matchedRules };
		}
		if (!admits(policy.acceptMode, strength)) {
			return { admissible: false, strength, refusal: { code: "not_allowed" }, matchedRules };
		}
		return { admissible: true, strength, matchedRules };
	}

	/** The codes a change bears on a live Ticket with; `policyEffectText` words them for the Ticket's worker. */
	effectsOf(from: Policy, to: Policy, ticket: Ticket): string[] {
		return policyEffects(from, to, ticket);
	}

	private self(source: SourceId): Actor | undefined {
		return this.selfOf?.()[source];
	}

	/**
	 * A Trigger asks the agent directly when the Source says a person addressed
	 * it, or when its text names the agent's own handle. Everything else on a
	 * watched Thread is a passive event: inferred at best.
	 */
	private addressesAgent(trigger: Trigger, self: Actor | undefined): boolean {
		if (DIRECT_KINDS.has(trigger.kind)) return true;
		const handle = self?.id;
		if (handle === undefined) return false;
		return trigger.text.toLowerCase().includes(`@${handle.toLowerCase()}`);
	}
}

export function createPolicyGate(options: PolicyGateOptions): PolicyGate {
	return new PolicyGate(options);
}

// ------------------------------------------------------------------ rules

/**
 * The rules a Trigger's text touches, by one plain rule: a rule applies when its
 * id, or a word of its text at least four characters long, occurs as a whole word
 * in the Trigger's text, compared case-insensitively.
 */
export function matchedRuleIds(policy: Policy, text: string): string[] {
	const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
	return policy.rules
		.filter((rule) => ruleWords(rule).some((word) => haystack.includes(` ${word} `)))
		.map((rule) => rule.id);
}

function ruleWords(rule: PolicyRule): string[] {
	const words = `${rule.id} ${rule.text}`.toLowerCase().split(/[^a-z0-9]+/);
	return [...new Set(words.filter((word) => word.length >= MIN_WORD))];
}

/** The Policy's rules that a Mandate relied on and that changed or disappeared. */
export function changedRules(from: Policy, to: Policy, ticket: Ticket): Array<{ before: PolicyRule; now?: PolicyRule }> {
	const changes: Array<{ before: PolicyRule; now?: PolicyRule }> = [];
	for (const id of ticket.mandate.matchedRules) {
		const before = from.rules.find((rule) => rule.id === id);
		if (before === undefined) continue;
		const now = to.rules.find((rule) => rule.id === id);
		if (now === undefined || now.text !== before.text || now.scope !== before.scope || now.strength !== before.strength) {
			changes.push(now === undefined ? { before } : { before, now });
		}
	}
	return changes;
}

/**
 * 002: a change bears on a Ticket when a rule it was accepted under changed or
 * no longer applies, when its requester may no longer start work, or when
 * proactive work is no longer accepted.
 */
export function policyEffects(from: Policy, to: Policy, ticket: Ticket): string[] {
	const codes: string[] = [];
	if (changedRules(from, to, ticket).length > 0) codes.push("rule_changed");
	if (!requesterAllowed(to, ticket)) codes.push("requester_blocked");
	if (ticket.mandate.strength === "inferred" && admits(from.acceptMode, "inferred") && !admits(to.acceptMode, "inferred")) {
		codes.push("proactive_off");
	}
	return codes;
}

/** One sentence a Ticket's worker reads, in plain words. */
export function policyEffectText(from: Policy, to: Policy, ticket: Ticket, codes: readonly string[]): string {
	const parts: string[] = [];
	if (codes.includes("rule_changed")) {
		const rules = changedRules(from, to, ticket).map(({ before, now }) =>
			now === undefined ? `${before.id} (withdrawn)` : `${now.id} (${now.text})`,
		);
		parts.push(`the rule this work was accepted under changed: ${rules.join(", ")}`);
	}
	if (codes.includes("requester_blocked")) parts.push("the requester may no longer start work");
	if (codes.includes("proactive_off")) parts.push("proactive work is no longer accepted");
	const because = parts.length > 0 ? parts.join("; ") : "nothing this work relied on was revoked";
	return `Policy ${from.version} → ${to.version}: ${because}. The mandate still stands: check the change before continuing.`;
}

// ------------------------------------------------------------- admission

/** 002: the mode admits the strength, judged strongest first. */
export function admits(mode: Policy["acceptMode"], strength: Strength): boolean {
	switch (mode) {
		case "off":
			return false;
		case "explicit":
			return strength === "explicit";
		case "inferred":
			return true;
	}
}

function requesterAllowed(policy: Policy, ticket: Ticket): boolean {
	const source = policy.sources[ticket.source];
	const requester = ticket.mandate.requester;
	if (source === undefined || !source.enabled || source.repository.trim() === "") return false;
	if (isBot(source, requester)) return false;
	return allowed(source, requester);
}

function allowed(source: SourcePolicy, actor: Actor): boolean {
	return source.allowedActors.some((id) => id.toLowerCase() === actor.id.toLowerCase());
}

function isBot(source: SourcePolicy, actor: Actor): boolean {
	return actor.bot || source.botActors.some((id) => id.toLowerCase() === actor.id.toLowerCase());
}

function sameActor(self: Actor | undefined, actor: Actor): boolean {
	return self !== undefined && self.id.toLowerCase() === actor.id.toLowerCase();
}
