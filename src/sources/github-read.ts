/**
 * The read side of the GitHub Source: one `gh` process per call, parsed JSON, and
 * a bounded retry for the failures that pass (5xx, rate limits, resets, timeouts).
 * Every call names its repository and number, so nothing depends on the cwd, and
 * `execFile` is used without a shell so a body is never re-interpreted.
 */
import { execFile, type ExecFileException } from "node:child_process";
import type { Ms } from "../core/model.js";

export interface GhOptions {
	/** A `gh` command name or absolute path. */
	bin?: string;
	/** Attempts per call, the first one included. */
	attempts?: number;
	/** Delay before the second attempt; it doubles per attempt. */
	backoffMs?: number;
	/** Kill one `gh` process after this long. */
	timeoutMs?: number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;
/** Check conclusions and commit status states that count as a failure; `success`, `neutral` and `skipped` do not. */
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "error"]);
const TRANSIENT = /(HTTP (408|429|5\d\d)|rate limit|connection (reset|refused|closed|aborted)|socket hang up|timed? ?out|EAI_AGAIN|ETIMEDOUT|ECONNRESET|TLS handshake)/i;

export class GhError extends Error {
	readonly exitCode: number | null;
	readonly transient: boolean;
	/** The HTTP status `gh` reported, when the message names one. */
	readonly status: number | undefined;

	constructor(message: string, exitCode: number | null, transient: boolean) {
		super(message);
		this.name = "GhError";
		this.exitCode = exitCode;
		this.transient = transient;
		const status = /HTTP (\d{3})/.exec(message);
		this.status = status?.[1] === undefined ? undefined : Number(status[1]);
	}
}

// ------------------------------------------------------------------- shapes

export interface GhUser {
	login?: string;
	type?: string;
	name?: string | null;
}

export interface GhComment {
	id?: number;
	body?: string | null;
	user?: GhUser | null;
	html_url?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
	issue_url?: string | null;
	pull_request_url?: string | null;
	path?: string | null;
	line?: number | null;
	original_line?: number | null;
	in_reply_to_id?: number | null;
}

export interface GhReview extends GhComment {
	state?: string | null;
	submitted_at?: string | null;
	commit_id?: string | null;
}

export interface GhCheckRun {
	id?: number;
	name?: string;
	status?: string;
	conclusion?: string | null;
	head_sha?: string;
}

export interface GhCommitStatus {
	id?: number;
	context?: string;
	state?: string;
	created_at?: string | null;
}

export interface GhPull {
	number?: number;
	title?: string;
	body?: string | null;
	state?: string;
	html_url?: string;
	created_at?: string;
	merged?: boolean | null;
	merged_at?: string | null;
	closed_at?: string | null;
	user?: GhUser | null;
	merged_by?: GhUser | null;
	head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null } | null;
	base?: { ref?: string } | null;
}

export interface GhNotification {
	id?: string;
	reason?: string;
	updated_at?: string;
	subject?: { title?: string; url?: string | null; type?: string };
	repository?: { full_name?: string };
}

export interface GhEvent {
	id?: string;
	type?: string;
	actor?: GhUser | null;
	created_at?: string;
	payload?: unknown;
}

export interface GhRepository {
	full_name?: string;
	default_branch?: string;
}

/** One commit's CI: what failed, what still runs, and whether everything passed. */
export interface CiState {
	sha: string;
	checks: GhCheckRun[];
	statuses: GhCommitStatus[];
	failed: Array<{ id: number; name: string }>;
	running: string[];
	passed: boolean;
}

/** The ids of the failing checks, which is what a CI Trigger's external id is built from. */
export function ciFailureIds(state: CiState): number[] {
	return state.failed.map((item) => item.id).sort((a, b) => a - b);
}

/** A sentence a person reads about one commit's CI, with the read that explains it. */
export function ciSummary(state: CiState, where: string, read: string): string {
	const total = state.checks.length + state.statuses.length;
	const at = `on ${where} at ${state.sha.slice(0, 7)}`;
	const names = (list: string[]): string => {
		const shown = list.slice(0, 5).join(", ");
		return list.length > 5 ? `${shown}, and ${list.length - 5} more` : shown;
	};
	const still = state.running.length > 0 ? `; ${state.running.length} still running` : "";
	const line = state.failed.length > 0
		? `CI failed ${state.failed.length}/${total} ${at}: ${names(state.failed.map((item) => item.name))}${still}`
		: state.running.length > 0
			? `CI running ${state.running.length}/${total} ${at}: ${names(state.running)}`
			: `CI passed ${total}/${total} ${at}`;
	return `${line}\nRead ${read} for every check.`;
}

// ---------------------------------------------------------------------- cli

export class GhCli {
	private readonly bin: string;
	private readonly attempts: number;
	private readonly backoffMs: number;
	private readonly timeoutMs: number;

	constructor(options: GhOptions = {}) {
		this.bin = options.bin ?? "gh";
		this.attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
		this.backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_BACKOFF_MS);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** One `gh api` call; `extra` carries headers, `--paginate --slurp` or `--method POST -f key=value`. */
	async call<T>(endpoint: string, extra: readonly string[] = []): Promise<T> {
		const stdout = await this.run(["api", endpoint, ...extra]);
		return parse<T>(stdout, endpoint);
	}

	/** Every page of a list endpoint, flattened. */
	async pages(endpoint: string): Promise<unknown[]> {
		const value = await this.call<unknown>(endpoint, ["--paginate", "--slurp"]);
		if (!Array.isArray(value)) return [];
		const flat: unknown[] = [];
		for (const page of value) {
			if (Array.isArray(page)) flat.push(...page);
			else if (isRecord(page)) flat.push(page);
		}
		return flat;
	}

	/** The account's notifications; `since` filters by the time GitHub last updated them. */
	async notifications(repository: string, options: { since?: Ms; all?: boolean } = {}): Promise<GhNotification[]> {
		const all = options.all === false ? "" : "&all=true";
		const since = options.since === undefined ? "" : `&since=${encodeURIComponent(new Date(options.since).toISOString())}`;
		const values = await this.pages(`notifications?per_page=50${all}${since}`);
		return values.filter(isRecord).map((value) => value as GhNotification).filter(mentions(repository));
	}

	/** Conversation comments: one Issue or PR's, or the whole repository's oldest-updated first. */
	async comments(repo: string, options: { number?: number; since?: Ms } = {}): Promise<GhComment[]> {
		const since = options.since === undefined ? "" : `&since=${encodeURIComponent(new Date(options.since).toISOString())}`;
		const endpoint = options.number === undefined
			? `repos/${repo}/issues/comments?sort=updated&direction=asc&per_page=100${since}`
			: `repos/${repo}/issues/${options.number}/comments?per_page=100${since}`;
		return (await this.pages(endpoint)).filter(isRecord).map((value) => value as GhComment);
	}

	/** Inline review comments: one PR's, or the whole repository's. */
	async reviewComments(repo: string, options: { number?: number; since?: Ms } = {}): Promise<GhComment[]> {
		const since = options.since === undefined ? "" : `&since=${encodeURIComponent(new Date(options.since).toISOString())}`;
		const endpoint = options.number === undefined
			? `repos/${repo}/pulls/comments?sort=updated&direction=asc&per_page=100${since}`
			: `repos/${repo}/pulls/${options.number}/comments?per_page=100${since}`;
		return (await this.pages(endpoint)).filter(isRecord).map((value) => value as GhComment);
	}

	/** A PR's reviews, oldest first; GitHub has no `since` for them, so the caller filters. */
	async reviews(repo: string, number: number): Promise<GhReview[]> {
		const values = await this.pages(`repos/${repo}/pulls/${number}/reviews?per_page=100`);
		return values.filter(isRecord).map((value) => value as GhReview);
	}

	async checkRuns(repo: string, sha: string): Promise<GhCheckRun[]> {
		const pages = await this.call<unknown>(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, ["--paginate", "--slurp"]);
		const runs: GhCheckRun[] = [];
		for (const page of Array.isArray(pages) ? pages : []) {
			if (!isRecord(page) || !Array.isArray(page.check_runs)) continue;
			for (const run of page.check_runs) if (isRecord(run)) runs.push(run as GhCheckRun);
		}
		return runs;
	}

	async commitStatuses(repo: string, sha: string): Promise<GhCommitStatus[]> {
		const values = await this.pages(`repos/${repo}/commits/${sha}/statuses?per_page=100`);
		return values.filter(isRecord).map((value) => value as GhCommitStatus);
	}

	/** One commit's CI, with the newest state per commit-status context: a context reports many times. */
	async ci(repo: string, sha: string): Promise<CiState> {
		const [checks, all] = await Promise.all([this.checkRuns(repo, sha), this.commitStatuses(repo, sha)]);
		const latest = new Map<string, GhCommitStatus>();
		for (const status of all) {
			const context = status.context ?? "";
			const known = latest.get(context);
			if (known === undefined || (status.created_at ?? "") >= (known.created_at ?? "")) latest.set(context, status);
		}
		const statuses = [...latest.values()];
		const failed: Array<{ id: number; name: string }> = [];
		for (const check of checks) {
			if (check.id !== undefined && FAILING.has(check.conclusion ?? "")) failed.push({ id: check.id, name: check.name ?? String(check.id) });
		}
		for (const status of statuses) {
			if (status.id !== undefined && FAILING.has(status.state ?? "")) failed.push({ id: status.id, name: status.context ?? String(status.id) });
		}
		const running = [
			...checks.filter((check) => check.status !== "completed").map((check) => check.name ?? ""),
			...statuses.filter((status) => status.state === "pending").map((status) => status.context ?? ""),
		].filter((name) => name !== "");
		const total = checks.length + statuses.length;
		return { sha, checks, statuses, failed, running, passed: failed.length === 0 && running.length === 0 && total > 0 };
	}

	async pull(repo: string, number: number): Promise<GhPull> {
		return this.call<GhPull>(`repos/${repo}/pulls/${number}`);
	}

	/** Repository events, newest first; the caller keeps the ones newer than its read position. */
	async events(repo: string): Promise<GhEvent[]> {
		const values = await this.pages(`repos/${repo}/events?per_page=100`);
		return values.filter(isRecord).map((value) => value as GhEvent);
	}

	/** The account `gh` is signed in as. */
	async viewer(): Promise<GhUser> {
		return this.call<GhUser>("user");
	}

	async repository(repo: string): Promise<GhRepository> {
		return this.call<GhRepository>(`repos/${repo}`);
	}

	/** The commit a branch points at. */
	async branchHead(repo: string, branch: string): Promise<string> {
		const commit = await this.call<{ sha?: string }>(`repos/${repo}/commits/${encodeURIComponent(branch)}`);
		if (commit.sha === undefined) throw new GhError(`The branch ${branch} of ${repo} has no head commit`, null, false);
		return commit.sha;
	}

	private async run(args: string[]): Promise<string> {
		let delay = this.backoffMs;
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await this.once(args);
			} catch (error) {
				const failure = error instanceof GhError ? error : new GhError(String(error), null, false);
				if (!failure.transient || attempt >= this.attempts) throw failure;
				await pause(delay);
				delay *= 2;
			}
		}
	}

	private once(args: string[]): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			execFile(this.bin, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: this.timeoutMs }, (error, stdout, stderr) => {
				if (error === null) {
					resolve(String(stdout));
					return;
				}
				const message = `${this.bin} ${args.join(" ")}: ${String(stderr ?? "").trim() || error.message}`;
				const code = typeof error.code === "number" ? error.code : null;
				reject(new GhError(message, code, transientOf(stderr, error)));
			});
		});
	}
}

// ------------------------------------------------------------------ helpers

function parse<T>(stdout: string, endpoint: string): T {
	const trimmed = stdout.trim();
	if (trimmed === "") return undefined as T;
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		throw new GhError(`gh api ${endpoint} did not return JSON`, null, false);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Notifications are account-wide: only the watched repository's are read. */
function mentions(repository: string): (value: GhNotification) => boolean {
	return (value) => sameName(value.repository?.full_name ?? "", repository);
}

export function sameName(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

function transientOf(stderr: string | Buffer | undefined, error: ExecFileException): boolean {
	if (error.killed === true) return true;
	// A missing binary is not a passing failure: no retry can install it.
	if (error.code === "ENOENT") return false;
	return TRANSIENT.test(String(stderr ?? "")) || TRANSIENT.test(error.message);
}

function pause(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
