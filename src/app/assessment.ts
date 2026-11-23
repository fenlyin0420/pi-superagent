/**
 * The Assessor: a model's judgement of a Trigger batch (docs/001-domain.md
 * "Eval", docs/002-authorization.md, prompts/assessment.md).
 *
 * The prompt is rendered from `prompts/assessment.md`, the model answers with
 * one strict JSON verdict, and the verdict is validated against the domain
 * types before the Engine records it. A parse or validation failure is retried
 * once; then the batch is answered `unavailable` so a person learns of it.
 *
 * The assessor never widens authority: an accept it returns is only a proposal,
 * the gate and the Engine still decide.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DecisionKind, Policy, Strength, Ticket, Trigger } from "../core/model.js";
import type { AssessmentInput, Assessor, AssessorVerdict, GateResult } from "../core/ports.js";

export const ASSESSMENT_PROMPT = "assessment";
const TRIGGER_MAX = 4000;
const HISTORY_MAX = 6000;
const BASIS_MAX = 1000;
const SCOPE_MAX = 600;
const REASONS_MAX = 20;

/** How the assessment asks a model for its verdict. */
export type AssessmentModel = (prompt: string, options: { json: true }) => Promise<string>;

export interface AssessorOptions {
	model: AssessmentModel;
	/** The rendered template; read from `prompts/assessment.md` when omitted. */
	prompt?: string;
	/** Where to read the prompt from, when the package layout differs. */
	promptFile?: string;
}

/** A verdict that could not be used: a parse error or a value the domain refuses. */
export class AssessmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AssessmentError";
	}
}

export class ModelAssessor implements Assessor {
	private readonly model: AssessmentModel;
	private readonly template: string;

	constructor(options: AssessorOptions) {
		this.model = options.model;
		this.template = options.prompt ?? readPrompt(ASSESSMENT_PROMPT, options.promptFile);
	}

	async assess(input: AssessmentInput): Promise<AssessorVerdict> {
		const prompt = renderAssessment(this.template, input);
		let failure = "the model gave no answer";
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const raw = await this.model(prompt, { json: true });
				return parseVerdict(raw, input);
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
		}
		return unavailable(input, failure);
	}
}

export function createAssessor(options: AssessorOptions): ModelAssessor {
	return new ModelAssessor(options);
}

// ------------------------------------------------------------------ verdict

/**
 * Parse and validate what the model answered. Throws `AssessmentError` when the
 * answer is not one usable verdict, so the caller can retry once.
 */
export function parseVerdict(raw: string, input: AssessmentInput): AssessorVerdict {
	const value = parseJson(raw);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AssessmentError("the verdict is not a JSON object");
	const record = value as Record<string, unknown>;
	const kind = decisionKind(record.kind);
	const strength = verdictStrength(record.strength, input.gate);
	const policies = new Set(input.policy.rules.map((rule) => rule.id));
	const matchedRules = strings(record.matchedRules ?? []).filter((id) => policies.has(id));
	const reasons = verdictReasons(record.reasons);
	if (kind === "accept" && input.gate.strength === "inferred" && input.gate.matchedRules.length === 0) {
		throw new AssessmentError("a proactive accept needs a matched policy rule, and the gate matched none");
	}
	if (kind === "accept" && strength === "inferred" && matchedRules.length === 0) {
		throw new AssessmentError("a proactive accept needs at least one matched rule");
	}
	const scope = text(record.scope, SCOPE_MAX);
	if (kind === "accept" && scope.trim() === "") {
		// 002: the mandate's scope names the work the accept grants; derive it, never invent it.
		return {
			kind,
			strength,
			basis: text(record.basis, BASIS_MAX),
			scope: deriveScope(input, matchedRules),
			matchedRules,
			reasons,
		};
	}
	return { kind, strength, basis: text(record.basis, BASIS_MAX), scope, matchedRules, reasons };
}

/** The verdict the Engine records as `unavailable` when the model gave nothing usable. */
export function unavailable(input: AssessmentInput, why: string): AssessorVerdict {
	const basis = `the assessment could not be judged: ${why}`.slice(0, BASIS_MAX);
	return {
		kind: "unavailable",
		strength: input.gate.strength,
		basis,
		scope: "",
		matchedRules: [],
		reasons: [{ code: "unavailable" }],
	};
}

/**
 * 002: an accepted proactive request is scoped by the request and the rules that
 * allowed it; an empty scope is filled from them rather than made up.
 */
export function deriveScope(input: AssessmentInput, matchedRules: readonly string[]): string {
	const trigger = input.triggers.find((item) => !item.actor.bot) ?? input.triggers[0];
	const request = trigger === undefined ? "" : collapse(trigger.text).slice(0, SCOPE_MAX);
	const rules = matchedRules.length === 0 ? "" : ` (policy rules: ${matchedRules.join(", ")})`;
	if (request !== "") return `${request.slice(0, SCOPE_MAX - rules.length)}${rules}`;
	return `the request on ${input.thread}${rules}`.slice(0, SCOPE_MAX);
}

// ------------------------------------------------------------------ prompt

export function renderAssessment(template: string, input: AssessmentInput): string {
	const values: Record<string, string> = {
		policyVersion: String(input.policy.version),
		acceptMode: input.policy.acceptMode,
		rules: ruleLines(input.policy),
		context: contextBlock(input),
	};
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

function ruleLines(policy: Policy): string {
	if (policy.rules.length === 0) return "No rule is enabled: a proactive candidate can only be ignored.";
	return policy.rules
		.map((rule) => `- ${rule.id} (${rule.strength}): ${collapse(rule.text)} — scope: ${collapse(rule.scope) || "as the rule reads"}`)
		.join("\n");
}

function contextBlock(input: AssessmentInput): string {
	const lines = [
		`Source: ${input.source}`,
		`Thread: ${input.thread}`,
		`Gate: ${input.gate.admissible ? "admissible" : "refused"} at strength ${input.gate.strength}${
			input.gate.refusal === undefined ? "" : ` (refusal: ${input.gate.refusal.code})`
		}`,
		`Matched rules: ${input.gate.matchedRules.length === 0 ? "none" : input.gate.matchedRules.join(", ")}`,
		"",
		"## Batch",
	];
	for (const trigger of input.triggers) lines.push(triggerBlock(trigger));
	lines.push("", "## Thread history", input.history.trim() === "" ? "No history was read." : truncate(input.history, HISTORY_MAX));
	lines.push("", "## Tickets on this thread");
	lines.push(input.tickets.length === 0 ? "None." : input.tickets.map(ticketLine).join("\n"));
	return lines.join("\n");
}

function triggerBlock(trigger: Trigger): string {
	const meta = `### ${trigger.id} — ${trigger.actor.id} (${trigger.kind}) on ${trigger.threads.join(", ") || "no thread"}${
		trigger.actor.bot ? ", bot" : ""
	}`;
	return `${meta}\n${truncate(trigger.text, TRIGGER_MAX) || "(empty)"}`;
}

function ticketLine(ticket: Ticket): string {
	const state = ticket.ended === undefined ? "open" : ticket.ended.outcome;
	const report = ticket.reports.at(-1);
	const last = report === undefined ? "no report" : `${report.kind}: ${collapse(report.text).slice(0, 200)}`;
	return `- ${ticket.id} (${state}, ${ticket.mandate.strength}): ${collapse(ticket.mandate.scope).slice(0, 300)} — ${last}`;
}

// ------------------------------------------------------------------ helpers

/** Read a prompt from the package's `prompts/` directory, or the file an option names. */
export function readPrompt(name: string, file?: string): string {
	if (file !== undefined) return readFileSync(file, "utf8");
	const override = process.env.PI_SUPERAGENT_PROMPTS?.trim();
	if (override) {
		try {
			return readFileSync(join(override, `${name}.md`), "utf8");
		} catch {
			/* Fall through to the package copy. */
		}
	}
	for (const directory of candidateRoots()) {
		try {
			return readFileSync(join(directory, "prompts", `${name}.md`), "utf8");
		} catch {
			/* Try the next one. */
		}
	}
	throw new Error(`Cannot find prompts/${name}.md; set PI_SUPERAGENT_PROMPTS to the directory that holds it`);
}

function candidateRoots(): string[] {
	const roots: string[] = [];
	let directory = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 6; depth += 1) {
		roots.push(directory);
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return roots;
}

function parseJson(raw: string): unknown {
	const text = raw.trim();
	const direct = tryParse(text);
	if (direct !== undefined) return direct;
	// A model may fence its JSON or wrap it in a sentence; take the outer object.
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) {
		const nested = tryParse(text.slice(start, end + 1));
		if (nested !== undefined) return nested;
	}
	throw new AssessmentError("the verdict is not JSON");
}

function tryParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function decisionKind(value: unknown): DecisionKind {
	if (value === "accept" || value === "stop" || value === "ignore" || value === "unavailable") return value;
	throw new AssessmentError(`unknown decision kind: ${String(value)}`);
}

function verdictStrength(value: unknown, gate: GateResult): Strength {
	// The gate knows whether a person addressed the agent; a model cannot weaken that.
	if (gate.strength === "explicit") return "explicit";
	if (value === "explicit" || value === "inferred") return value;
	throw new AssessmentError(`unknown strength: ${String(value)}`);
}

function verdictReasons(value: unknown): AssessorVerdict["reasons"] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new AssessmentError("reasons must be an array");
	return value.slice(0, REASONS_MAX).map((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new AssessmentError("a reason must be an object");
		const record = item as Record<string, unknown>;
		const code = text(record.code, 80).trim();
		if (code === "") throw new AssessmentError("a reason needs a code");
		const values = stringRecord(record.values);
		return values === undefined ? { code } : { code, values };
	});
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AssessmentError("reason values must be an object of strings");
	const record: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") throw new AssessmentError(`reason value ${key} must be a string`);
		record[key] = item;
	}
	return record;
}

function text(value: unknown, max: number): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw new AssessmentError("expected a string");
	return value.slice(0, max);
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
