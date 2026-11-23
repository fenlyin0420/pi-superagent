/**
 * Deployment settings in `<state>/settings.json` (docs/000-design.md "Runtime").
 *
 * Settings are the only source of policy: nothing an agent reads from a Source
 * can change them (invariant 6). The file holds the policy, the GitHub source
 * part, the executor and the panel locale. Every policy write bumps
 * `policy.version` and `updatedAt`, and input from a person is answered with
 * structured problems rather than an exception.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AcceptMode, Ms, Policy, PolicyRule, SourceId, SourcePolicy, Strength } from "../core/model.js";
import type { Locale } from "../core/reasons.js";

export const SETTINGS_VERSION = 1;
export const DEFAULT_POLL_MS = 60_000;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_LOCALE: Locale = "en";

const RULE_ID = /^[a-z][a-z0-9_-]*$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const RULE_TEXT_MAX = 2000;
const MODEL_MAX = 200;
const PREPARE_MAX = 4000;

export interface ExecutorSettings {
	/** Model id a worker turn runs with; empty inherits Pi's configured default. */
	model: string;
	/** Worker turns that may run at once across all tickets. */
	concurrency: number;
	/** Shell command run once in a ticket directory before its first launch. */
	prepare: string;
	/** Root under which each ticket directory is created. */
	root: string;
	/** Branch a ticket's pull request targets. */
	baseBranch: string;
	/** The GitHub login the agent acts as, and commits as. */
	account: string;
	/** Commit email; empty derives `<account>@users.noreply.github.com`. */
	commitEmail: string;
}

export interface PanelSettings {
	locale: Locale;
}

export interface Settings {
	version: number;
	/** Overrides the default state directory, so the file finds itself after a move. */
	stateDir: string;
	policy: Policy;
	executor: ExecutorSettings;
	panel: PanelSettings;
}

export interface SettingsProblem {
	/** Dotted path inside the settings document, empty for the document itself. */
	path: string;
	message: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; problems: SettingsProblem[] };

export interface LoadedSettings {
	settings: Settings;
	problems: SettingsProblem[];
}

// ------------------------------------------------------------------ defaults

export function defaultSourcePolicy(): SourcePolicy {
	return {
		enabled: false,
		repository: "",
		allowedActors: [],
		botActors: [],
		watchAll: false,
		pollMs: DEFAULT_POLL_MS,
	};
}

export function defaultPolicy(clock: () => Ms = Date.now): Policy {
	return {
		version: 1,
		acceptMode: "off",
		rules: [],
		sources: { github: defaultSourcePolicy() },
		updatedAt: clock(),
	};
}

export function defaultSettings(options: { workRoot: string; clock?: () => Ms }): Settings {
	const clock = options.clock ?? Date.now;
	return {
		version: SETTINGS_VERSION,
		stateDir: "",
		policy: defaultPolicy(clock),
		executor: {
			model: "",
			concurrency: DEFAULT_CONCURRENCY,
			prepare: "",
			root: options.workRoot,
			baseBranch: DEFAULT_BASE_BRANCH,
			account: "",
			commitEmail: "",
		},
		panel: { locale: DEFAULT_LOCALE },
	};
}

/** The identity a worker commits as (docs/004 "Delivery requirements"). */
export function commitAuthor(settings: Settings): { name: string; email: string } {
	const account = settings.executor.account.trim();
	const email = settings.executor.commitEmail.trim() || (account === "" ? "" : `${account}@users.noreply.github.com`);
	return { name: account === "" ? "pi-superagent" : account, email };
}

// --------------------------------------------------------------- validation

export function validateSettings(value: unknown, options: { workRoot: string; clock?: () => Ms }): Validation<Settings> {
	const { settings, problems } = normalizeSettings(value, defaultSettings(options));
	return problems.length > 0 ? { ok: false, problems } : { ok: true, value: settings };
}

/** Read settings from a file, replacing an unreadable document with defaults and reporting why. */
export function loadSettings(file: string, options: { workRoot: string; clock?: () => Ms }): LoadedSettings {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { settings: defaultSettings(options), problems: [] };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { settings: defaultSettings(options), problems: [{ path: "", message: "settings.json is not valid JSON" }] };
	}
	return normalizeSettings(value, defaultSettings(options));
}

export function normalizeSettings(value: unknown, fallback: Settings): LoadedSettings {
	const collector = new Collector();
	if (!isRecord(value)) {
		collector.add("", "settings must be a JSON object");
		return { settings: fallback, problems: collector.problems };
	}
	const settings: Settings = {
		version: SETTINGS_VERSION,
		stateDir: asText(collector, "stateDir", value.stateDir, fallback.stateDir, { max: 4096 }),
		policy: asPolicy(collector, "policy", value.policy, fallback.policy),
		executor: asExecutor(collector, "executor", value.executor, fallback.executor),
		panel: asPanel(collector, "panel", value.panel, fallback.panel),
	};
	if (value.version !== undefined && value.version !== SETTINGS_VERSION) {
		collector.add("version", `unsupported settings version; expected ${SETTINGS_VERSION}`);
	}
	return { settings, problems: collector.problems };
}

/** Policy input from a person: fields it names replace the current policy, the rest stays. */
export function policyInput(value: unknown, base: Policy): Validation<Policy> {
	if (!isRecord(value)) return { ok: false, problems: [{ path: "policy", message: "policy must be a JSON object" }] };
	const collector = new Collector();
	const merged: Record<string, unknown> = {
		version: base.version,
		updatedAt: base.updatedAt,
		acceptMode: value.acceptMode ?? base.acceptMode,
		rules: value.rules ?? base.rules,
		sources: isRecord(value.sources) ? { ...base.sources, ...value.sources } : base.sources,
	};
	const policy = asPolicy(collector, "policy", merged, base);
	return collector.problems.length > 0 ? { ok: false, problems: collector.problems } : { ok: true, value: policy };
}

export function executorInput(value: unknown, base: ExecutorSettings): Validation<ExecutorSettings> {
	const collector = new Collector();
	const executor = asExecutor(collector, "executor", value, base);
	return collector.problems.length > 0 ? { ok: false, problems: collector.problems } : { ok: true, value: executor };
}

export function panelInput(value: unknown, base: PanelSettings): Validation<PanelSettings> {
	const collector = new Collector();
	const panel = asPanel(collector, "panel", value, base);
	return collector.problems.length > 0 ? { ok: false, problems: collector.problems } : { ok: true, value: panel };
}

// -------------------------------------------------------------------- file

export interface SettingsFileOptions {
	file: string;
	workRoot: string;
	clock?: () => Ms;
}

/**
 * The settings document, kept in memory and written atomically. Writers answer
 * structured problems; only a failing disk write throws.
 */
export class SettingsFile {
	readonly file: string;
	private readonly workRoot: string;
	private readonly clock: () => Ms;
	private current: Settings;

	constructor(options: SettingsFileOptions) {
		this.file = options.file;
		this.workRoot = options.workRoot;
		this.clock = options.clock ?? Date.now;
		this.current = defaultSettings({ workRoot: this.workRoot, clock: this.clock });
	}

	load(): LoadedSettings {
		const loaded = loadSettings(this.file, { workRoot: this.workRoot, clock: this.clock });
		this.current = loaded.settings;
		return loaded;
	}

	/**
	 * Write the document when the state directory has none. A host calls this once
	 * it owns the directory, so the deployment's settings are there to read and to
	 * edit even before the first policy change.
	 */
	ensureFile(): void {
		if (existsSync(this.file)) return;
		this.persist(this.current);
	}

	get(): Settings {
		return this.current;
	}

	policy(): Policy {
		return this.current.policy;
	}

	/** Persist a policy change; each successful write bumps the version and `updatedAt`. */
	savePolicy(input: unknown): Validation<Policy> {
		const validated = policyInput(input, this.current.policy);
		if (!validated.ok) return validated;
		const next: Policy = { ...validated.value, version: this.current.policy.version + 1, updatedAt: this.clock() };
		this.persist({ ...this.current, policy: next });
		return { ok: true, value: next };
	}

	saveExecutor(input: unknown): Validation<ExecutorSettings> {
		const validated = executorInput(input, this.current.executor);
		if (!validated.ok) return validated;
		this.persist({ ...this.current, executor: validated.value });
		return validated;
	}

	savePanel(input: unknown): Validation<PanelSettings> {
		const validated = panelInput(input, this.current.panel);
		if (!validated.ok) return validated;
		this.persist({ ...this.current, panel: validated.value });
		return validated;
	}

	private persist(next: Settings): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`);
		renameSync(temporary, this.file);
		this.current = next;
	}
}

// ------------------------------------------------------------- normalizers

class Collector {
	readonly problems: SettingsProblem[] = [];

	add(path: string, message: string): void {
		this.problems.push({ path, message });
	}
}

function asPolicy(collector: Collector, path: string, value: unknown, fallback: Policy): Policy {
	if (value === undefined) return fallback;
	if (!isRecord(value)) {
		collector.add(path, "must be a JSON object");
		return fallback;
	}
	return {
		version: asInteger(collector, `${path}.version`, value.version, fallback.version, 1, Number.MAX_SAFE_INTEGER),
		acceptMode: asAcceptMode(collector, `${path}.acceptMode`, value.acceptMode, fallback.acceptMode),
		rules: asRules(collector, `${path}.rules`, value.rules, fallback.rules),
		sources: asSources(collector, `${path}.sources`, value.sources, fallback.sources),
		updatedAt: asInteger(collector, `${path}.updatedAt`, value.updatedAt, fallback.updatedAt, 0, Number.MAX_SAFE_INTEGER),
	};
}

function asAcceptMode(collector: Collector, path: string, value: unknown, fallback: AcceptMode): AcceptMode {
	if (value === undefined) return fallback;
	if (value === "off" || value === "explicit" || value === "inferred") return value;
	collector.add(path, 'must be "off", "explicit" or "inferred"');
	return fallback;
}

function asStrength(collector: Collector, path: string, value: unknown, fallback: Strength): Strength {
	if (value === undefined) return fallback;
	if (value === "explicit" || value === "inferred") return value;
	collector.add(path, 'must be "explicit" or "inferred"');
	return fallback;
}

function asRules(collector: Collector, path: string, value: unknown, fallback: PolicyRule[]): PolicyRule[] {
	if (value === undefined) return fallback;
	if (!Array.isArray(value)) {
		collector.add(path, "must be an array of rules");
		return fallback;
	}
	const rules: PolicyRule[] = [];
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		const at = `${path}.${index}`;
		if (!isRecord(item)) {
			collector.add(at, "must be a JSON object");
			continue;
		}
		const id = asText(collector, `${at}.id`, item.id, "", { max: 64, pattern: RULE_ID, allowEmpty: false });
		if (id === "") continue;
		if (seen.has(id)) {
			collector.add(`${at}.id`, `duplicate rule id: ${id}`);
			continue;
		}
		seen.add(id);
		rules.push({
			id,
			text: asText(collector, `${at}.text`, item.text, "", { max: RULE_TEXT_MAX, allowEmpty: false }),
			scope: asText(collector, `${at}.scope`, item.scope, "", { max: RULE_TEXT_MAX }),
			strength: asStrength(collector, `${at}.strength`, item.strength, "explicit"),
		});
	}
	return rules;
}

function asSources(
	collector: Collector,
	path: string,
	value: unknown,
	fallback: Record<SourceId, SourcePolicy>,
): Record<SourceId, SourcePolicy> {
	if (value === undefined) return fallback;
	if (!isRecord(value)) {
		collector.add(path, "must be an object of source policies");
		return fallback;
	}
	const sources: Record<SourceId, SourcePolicy> = { ...fallback };
	for (const [id, part] of Object.entries(value)) {
		if (id.trim() === "") {
			collector.add(path, "a source needs a non-empty id");
			continue;
		}
		sources[id] = asSourcePolicy(collector, `${path}.${id}`, part, fallback[id] ?? defaultSourcePolicy());
	}
	return sources;
}

function asSourcePolicy(collector: Collector, path: string, value: unknown, fallback: SourcePolicy): SourcePolicy {
	if (value === undefined) return fallback;
	if (!isRecord(value)) {
		collector.add(path, "must be a JSON object");
		return fallback;
	}
	return {
		enabled: asBoolean(collector, `${path}.enabled`, value.enabled, fallback.enabled),
		repository: asText(collector, `${path}.repository`, value.repository, fallback.repository, {
			max: 200,
			pattern: REPOSITORY,
			patternMessage: "must read owner/name",
		}),
		allowedActors: asIdentityList(collector, `${path}.allowedActors`, value.allowedActors, fallback.allowedActors),
		botActors: asIdentityList(collector, `${path}.botActors`, value.botActors, fallback.botActors),
		watchAll: asBoolean(collector, `${path}.watchAll`, value.watchAll, fallback.watchAll),
		pollMs: asInteger(collector, `${path}.pollMs`, value.pollMs, fallback.pollMs, 1000, 3_600_000),
	};
}

function asExecutor(collector: Collector, path: string, value: unknown, fallback: ExecutorSettings): ExecutorSettings {
	if (value === undefined) return fallback;
	if (!isRecord(value)) {
		collector.add(path, "must be a JSON object");
		return fallback;
	}
	const account = asText(collector, `${path}.account`, value.account, fallback.account, {
		max: 100,
		pattern: LOGIN,
		patternMessage: "must be a GitHub login",
	});
	return {
		model: asText(collector, `${path}.model`, value.model, fallback.model, { max: MODEL_MAX }),
		concurrency: asInteger(collector, `${path}.concurrency`, value.concurrency, fallback.concurrency, 1, 16),
		prepare: asText(collector, `${path}.prepare`, value.prepare, fallback.prepare, { max: PREPARE_MAX }),
		root: asText(collector, `${path}.root`, value.root, fallback.root, { max: 4096, allowEmpty: false }),
		baseBranch: asText(collector, `${path}.baseBranch`, value.baseBranch, fallback.baseBranch, {
			max: 200,
			pattern: BRANCH,
			patternMessage: "must be a branch name",
			allowEmpty: false,
		}),
		account,
		commitEmail: asText(collector, `${path}.commitEmail`, value.commitEmail, fallback.commitEmail, { max: 200 }),
	};
}

function asPanel(collector: Collector, path: string, value: unknown, fallback: PanelSettings): PanelSettings {
	if (value === undefined) return fallback;
	if (!isRecord(value)) {
		collector.add(path, "must be a JSON object");
		return fallback;
	}
	if (value.locale === undefined) return fallback;
	if (value.locale === "en" || value.locale === "zh") return { locale: value.locale };
	collector.add(`${path}.locale`, 'must be "en" or "zh"');
	return fallback;
}

// ---------------------------------------------------------------- primitives

function asText(
	collector: Collector,
	path: string,
	value: unknown,
	fallback: string,
	options: { max?: number; pattern?: RegExp; patternMessage?: string; allowEmpty?: boolean } = {},
): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string") {
		collector.add(path, "must be a string");
		return fallback;
	}
	const text = value.trim();
	if (text === "" && options.allowEmpty === false) {
		collector.add(path, "must not be empty");
		return fallback;
	}
	if (options.max !== undefined && text.length > options.max) {
		collector.add(path, `must be at most ${options.max} characters`);
		return fallback;
	}
	if (text !== "" && options.pattern !== undefined && !options.pattern.test(text)) {
		collector.add(path, options.patternMessage ?? "has an unexpected format");
		return fallback;
	}
	return text;
}

function asIdentityList(collector: Collector, path: string, value: unknown, fallback: string[]): string[] {
	if (value === undefined) return fallback;
	if (!Array.isArray(value)) {
		collector.add(path, "must be an array of strings");
		return fallback;
	}
	const identities: string[] = [];
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string" || item.trim() === "") {
			collector.add(`${path}.${index}`, "must be a non-empty string");
			continue;
		}
		identities.push(item.trim());
	}
	return identities;
}

function asInteger(collector: Collector, path: string, value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		collector.add(path, `must be an integer between ${min} and ${max}`);
		return fallback;
	}
	return value;
}

function asBoolean(collector: Collector, path: string, value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		collector.add(path, "must be true or false");
		return fallback;
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
