/**
 * The GitHub Source (docs/000-design.md "GitHub source"): polls one repository
 * through the agent's `gh`, turns what it reads into Triggers on their Threads,
 * and holds one read position per kind so a restart never replays an event.
 *
 * The Source only ever calls `SourceScope`: it writes no state of its own, and
 * it drops the agent's own and bot events before the domain sees them.
 */
import type {
	Actor,
	ChannelAddress,
	Filtered,
	Ms,
	SourceId,
	ThreadKey,
	Trigger,
} from "../core/model.js";
import type { OutboundMessage, Source as SourcePort, SourceScope } from "../core/ports.js";
import {
	GhCli,
	ciFailureIds,
	ciSummary,
	sameName,
	type CiState,
	type GhComment,
	type GhEvent,
	type GhNotification,
	type GhPull,
	type GhReview,
	type GhUser,
} from "./github-read.js";
import { pullOf, pullThread, pullsOf, type PullOutcome, type TrackedTicket } from "./github-pull.js";

export const SOURCE: SourceId = "github";

const GITHUB: Actor = { id: "github", bot: true, name: "GitHub" };
const MAX_TEXT = 4_000;
const PROBLEM_AFTER = 3;
const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 10_000;
/** A turn of the polling timer's wait that keeps two hosts from polling in step. */
const JITTER = 0.1;

/** One read position per kind, plus the account's own login and the CI state of each read sha. */
const POSITION = {
	notification: "notification",
	issueComment: "issue_comment",
	prComment: "pr_comment",
	review: "pr_review",
	reviewComment: "pr_review_comment",
	event: "event",
	self: "self",
} as const;

export interface GithubSourceOptions {
	gh?: GhCli;
	now?: () => Ms;
	random?: () => number;
	/**
	 * The host's Tickets, so a pull request the agent opened from a Ticket's
	 * branch binds to it (`SourceScope.bindThread`). Without them the Source still
	 * reads everything else; it just never learns which Ticket a pull request is.
	 */
	tickets?: () => readonly TrackedTicket[];
}

export class GithubSource implements SourcePort {
	readonly id: SourceId = SOURCE;
	private readonly gh: GhCli;
	private readonly clock: () => Ms;
	private readonly random: () => number;
	private readonly ticketList: () => readonly TrackedTicket[];
	private scope?: SourceScope;
	private login?: string;
	private timer?: NodeJS.Timeout;
	private inflight?: Promise<void>;
	private stopped = true;
	private failures = 0;
	private lastPollAt?: Ms;
	private lastError?: { at: Ms; message: string };

	constructor(options: GithubSourceOptions = {}) {
		this.gh = options.gh ?? new GhCli();
		this.clock = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.ticketList = options.tickets ?? (() => []);
	}

	// --------------------------------------------------------------- Source

	start(scope: SourceScope): void {
		if (this.scope !== undefined && !this.stopped) throw new Error("The GitHub Source is already started");
		this.scope = scope;
		this.stopped = false;
		this.failures = 0;
		this.schedule(this.wait());
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const running = this.inflight;
		if (running !== undefined) await running.catch(() => undefined);
	}

	/** Poll now instead of waiting for the interval; a poll already running is awaited, not repeated. */
	poll(): Promise<void> {
		const running = this.inflight;
		if (running !== undefined) return running;
		const round = this.run();
		this.inflight = round;
		return round.finally(() => {
			if (this.inflight === round) this.inflight = undefined;
		});
	}

	status(): { lastPollAt?: Ms; lastError?: { at: Ms; message: string } } {
		return this.lastError === undefined
			? { lastPollAt: this.lastPollAt }
			: { lastPollAt: this.lastPollAt, lastError: this.lastError };
	}

	/** The account `gh` is signed in as, once a poll has read it. */
	self(): Actor | undefined {
		return this.login === undefined ? undefined : { id: this.login, bot: false };
	}

	// --------------------------------------------------------------- writes

	/** Outbox: whether this Source still writes to a conversation. */
	listens(conversation: string): boolean {
		const target = conversationAt(conversation);
		if (target === undefined) return false;
		const policy = this.policyOf();
		return policy !== undefined && policy.enabled && sameName(policy.repository.trim(), target.repo);
	}

	/**
	 * Outbox: posts a Markdown body as a comment, or as a reply in a review thread.
	 * The message id goes into an HTML comment so a retried effect finds the
	 * comment it already made instead of posting a second one.
	 */
	async post(message: OutboundMessage): Promise<string | undefined> {
		const target = conversationAt(message.channel.conversation);
		if (target === undefined) throw new Error(`The GitHub Source cannot write to ${message.channel.conversation}`);
		const body = message.body.trim();
		if (body === "") return undefined;
		const root = reviewRoot(message.channel.ref);
		const endpoint = root === undefined
			? `repos/${target.repo}/issues/${target.number}/comments`
			: `repos/${target.repo}/pulls/${target.number}/comments/${root}/replies`;
		const posted = await this.posted(target, message.id, root);
		if (posted !== undefined) return posted;
		const marker = `\n\n<!-- pi-superagent:${message.id} -->`;
		const created = await this.gh.call<{ id?: number }>(endpoint, ["--method", "POST", "-f", `body=${body}${marker}`]);
		return created?.id === undefined ? undefined : String(created.id);
	}

	private async posted(
		target: { repo: string; number: number },
		id: string,
		root: number | undefined,
	): Promise<string | undefined> {
		const endpoint = root === undefined
			? `repos/${target.repo}/issues/${target.number}/comments?per_page=100`
			: `repos/${target.repo}/pulls/${target.number}/comments?per_page=100`;
		const marker = `<!-- pi-superagent:${id} -->`;
		const listed: unknown = await this.gh.call<unknown>(endpoint).catch(() => undefined);
		if (!Array.isArray(listed)) return undefined;
		for (const value of listed) {
			if (!isRecord(value) || typeof value.body !== "string" || !value.body.includes(marker)) continue;
			if (root !== undefined && value.in_reply_to_id !== root && value.id !== root) continue;
			const login = this.login;
			if (login !== undefined && !sameName(String(userLogin(value.user) ?? ""), login)) continue;
			return value.id === undefined ? undefined : String(value.id);
		}
		return undefined;
	}

	// ------------------------------------------------------------- polling

	private schedule(delay: number): void {
		if (this.stopped) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.poll().then(() => this.schedule(this.wait()));
		}, delay);
		// A polling Source must not be the only thing keeping the host process alive.
		this.timer.unref?.();
	}

	/** The policy's interval, jittered by ±10%: two hosts on one repository never poll in step. */
	private wait(): number {
		const pollMs = Math.max(MIN_POLL_MS, this.policyOf()?.pollMs ?? DEFAULT_POLL_MS);
		return Math.round(pollMs * (1 + (this.random() * 2 - 1) * JITTER));
	}

	private async run(): Promise<void> {
		if (this.stopped) return;
		try {
			await this.round();
			this.failures = 0;
			this.lastPollAt = this.clock();
			delete this.lastError;
		} catch (error) {
			this.failures += 1;
			const message = error instanceof Error ? error.message : String(error);
			this.lastError = { at: this.clock(), message };
			// One interruption is retried by the next poll; three in a row need a person.
			if (this.failures === PROBLEM_AFTER) this.scope?.problem("poll_failed", message);
		}
	}

	private async round(): Promise<void> {
		const policy = this.policyOf();
		if (policy === undefined || !policy.enabled || policy.repository.trim() === "") return;
		const repo = policy.repository.trim();
		const started = this.clock();
		const login = await this.loginName();
		const watched = new Set<number>();
		for (const ticket of this.ticketList()) {
			for (const number of pullsOf(ticket, { openOnly: true })) watched.add(number);
		}
		await this.notifications(repo, started, watched);
		if (policy.watchAll) await this.events(repo, started, watched);
		await this.comments(repo, started, watched);
		await this.reviewComments(repo, started, watched);
		await this.reviews(repo, started, watched);
		await this.pulls(repo, login, watched);
		await this.branchCi(repo);
	}

	/** 001: the account's notifications name the Issue or PR a person addressed the agent on. */
	private async notifications(repo: string, started: Ms, watched: Set<number>): Promise<void> {
		const since = this.cursor(POSITION.notification, started);
		for (const item of await this.gh.notifications(repo, { since })) {
			const target = addressOf(item.subject?.url ?? "", repo);
			if (target === undefined) continue;
			if (target.pr) watched.add(target.number);
			this.observe(notificationTrigger(repo, item, target, this.clock()));
		}
		this.advance(POSITION.notification, started);
	}

	/** 002: only with `watchAll` are issues and pull requests nobody addressed to the agent read. */
	private async events(repo: string, started: Ms, watched: Set<number>): Promise<void> {
		const stored = this.scope?.position(POSITION.event);
		const since = typeof stored === "number" ? stored : undefined;
		const events = await this.gh.events(repo);
		let newest = since ?? 0;
		for (const event of events) {
			const id = Number(event.id);
			if (Number.isFinite(id) && id > newest) newest = id;
			// The first read only establishes the baseline: what happened before it is not reported.
			if (since === undefined || !Number.isFinite(id) || id <= since) continue;
			this.openedEvent(repo, event, watched);
		}
		// The position is the newest event id, not a time: an older event never arrives after a newer one.
		if (since === undefined ? newest > 0 : newest > since) this.scope?.setPosition(POSITION.event, newest);
	}

	private openedEvent(repo: string, event: GhEvent, watched: Set<number>): void {
		const at = Date.parse(event.created_at ?? "");
		if (!Number.isFinite(at)) return;
		const payload = isRecord(event.payload) ? event.payload : {};
		if (payload.action !== "opened") return;
		if (event.type === "IssuesEvent") {
			const issue = isRecord(payload.issue) ? payload.issue : undefined;
			const number = numberValue(issue?.number);
			if (issue === undefined || number === undefined) return;
			this.accept(openedTrigger(repo, "issue_opened", number, false, {
				title: stringValue(issue.title),
				body: stringValue(issue.body),
				user: userOf(issue.user),
				url: stringValue(issue.html_url),
			}, at));
			return;
		}
		if (event.type !== "PullRequestEvent") return;
		const pull = isRecord(payload.pull_request) ? payload.pull_request : undefined;
		const number = numberValue(pull?.number);
		if (pull === undefined || number === undefined) return;
		watched.add(number);
		const head = isRecord(pull.head) ? stringValue(pull.head.ref) : undefined;
		this.accept(openedTrigger(repo, "pr_opened", number, true, {
			title: stringValue(pull.title),
			body: stringValue(pull.body),
			user: userOf(pull.user),
			url: stringValue(pull.html_url),
			branch: head,
		}, at));
	}

	/** Conversation comments arrive for the whole repository, Issues and pull requests alike. */
	private async comments(repo: string, started: Ms, watched: Set<number>): Promise<void> {
		const since = Math.min(this.cursor(POSITION.issueComment, started), this.cursor(POSITION.prComment, started));
		for (const comment of await this.gh.comments(repo, { since })) {
			const at = this.at(comment.updated_at ?? comment.created_at);
			if (at === undefined || at < since) continue;
			const number = numberIn(comment.issue_url ?? "") ?? numberIn(comment.html_url ?? "");
			if (number === undefined) continue;
			const isPr = isPullUrl(comment.html_url ?? "") || isPullUrl(comment.issue_url ?? "");
			if (isPr) watched.add(number);
			const trigger = commentTrigger({ repo, number, isPr }, comment, at);
			if (trigger !== undefined) this.accept(trigger);
		}
		this.advance(POSITION.issueComment, started);
		this.advance(POSITION.prComment, started);
	}

	/** Inline review comments belong to a review thread, whose root comment the Trigger carries. */
	private async reviewComments(repo: string, started: Ms, watched: Set<number>): Promise<void> {
		const since = this.cursor(POSITION.reviewComment, started);
		for (const comment of await this.gh.reviewComments(repo, { since })) {
			const at = this.at(comment.updated_at ?? comment.created_at);
			if (at === undefined || at < since) continue;
			const number = numberIn(comment.pull_request_url ?? "") ?? numberIn(comment.html_url ?? "");
			if (number === undefined || comment.id === undefined) continue;
			watched.add(number);
			const root = comment.in_reply_to_id ?? comment.id;
			const trigger = reviewCommentTrigger({ repo, number, isPr: true }, comment, root, at);
			if (trigger !== undefined) this.accept(trigger);
		}
		this.advance(POSITION.reviewComment, started);
	}

	/** A review without a body still counts: a worker may be waiting for that approval. */
	private async reviews(repo: string, started: Ms, watched: Set<number>): Promise<void> {
		const since = this.cursor(POSITION.review, started);
		for (const number of watched) {
			for (const review of await this.gh.reviews(repo, number)) {
				const at = this.at(review.submitted_at ?? review.created_at);
				if (at === undefined || at < since) continue;
				const trigger = reviewTrigger({ repo, number, isPr: true }, review, at);
				if (trigger !== undefined) this.accept(trigger);
			}
		}
		this.advance(POSITION.review, started);
	}

	/** Every watched pull request: its end closes the Thread, its branch may bind a Ticket, its head has CI. */
	private async pulls(repo: string, login: string, watched: Set<number>): Promise<void> {
		for (const number of watched) {
			const tracked = await pullOf(this.gh, repo, number, login, this.ticketList());
			if (tracked === undefined) continue;
			if (tracked.outcome !== undefined) {
				this.closed(repo, tracked.number, tracked.pull, tracked.outcome);
				continue;
			}
			if (tracked.claim !== undefined && pullsOf(tracked.claim, { openOnly: true }).length === 0) {
				try {
					this.scope?.bindThread(tracked.claim.id, tracked.thread, true);
				} catch {
					// The Ticket ended between the read and the bind; nothing to follow.
				}
			}
			const head = tracked.pull.head?.sha;
			if (head !== undefined && head !== "") await this.ci(repo, head, { number });
		}
	}

	private async branchCi(repo: string): Promise<void> {
		const repository = await this.gh.repository(repo);
		const branch = repository.default_branch;
		if (branch === undefined || branch === "") return;
		const head = await this.gh.branchHead(repo, branch);
		await this.ci(repo, head, { branch });
	}

	/** 001: CI failures and recoveries only; the first observation of a commit is its baseline. */
	private async ci(repo: string, sha: string, where: { number?: number; branch?: string }): Promise<void> {
		const state = await this.gh.ci(repo, sha);
		const key = `ci:${sha}`;
		const previous = this.failureIds(key);
		const failed = ciFailureIds(state);
		if (previous !== undefined && sameIds(previous, failed)) {
			this.remember(key, failed);
			return;
		}
		const first = previous === undefined;
		this.remember(key, failed);
		// Keep the last failure list while checks still run, so a recovery is reported once everything passed.
		if (first || (failed.length === 0 && state.running.length > 0)) return;
		this.observe(ciTrigger(repo, state, this.clock(), where));
	}

	private failureIds(key: string): number[] | undefined {
		const stored = this.scope?.position(key);
		if (typeof stored !== "string") return undefined;
		try {
			const value: unknown = JSON.parse(stored);
			return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : undefined;
		} catch {
			return undefined;
		}
	}

	private remember(key: string, failed: number[]): void {
		this.scope?.setPosition(key, JSON.stringify(failed));
	}

	private closed(repo: string, number: number, pull: GhPull, outcome: PullOutcome): void {
		if (this.stopped) return;
		this.scope?.threadClosed(pullThread(number), outcome.outcome, outcome.at);
		this.observe(closeTrigger(repo, number, pull, outcome));
	}

	// ---------------------------------------------------------- domain calls

	/** A person's or a bot's event: dropped when the agent wrote it or a bot did. */
	private accept(trigger: Trigger): void {
		if (this.dropped(trigger.actor)) return;
		this.observe(trigger);
	}

	/** An event the Source observed rather than attributed, such as CI or a Thread's close. */
	private observe(trigger: Trigger): void {
		if (this.stopped) return;
		this.scope?.receive(trigger);
	}

	private dropped(actor: Actor): boolean {
		if (actor.id === "" || actor.bot) return true;
		const self = this.login ?? this.scope?.self()?.id;
		if (self !== undefined && sameName(self, actor.id)) return true;
		return (this.policyOf()?.botActors ?? []).some((id) => sameName(id, actor.id));
	}

	// --------------------------------------------------------------- reads

	private policyOf() {
		return this.scope?.policy().sources[this.id];
	}

	private async loginName(): Promise<string> {
		if (this.login !== undefined) return this.login;
		const stored = this.scope?.position(POSITION.self);
		if (typeof stored === "string" && stored !== "") {
			this.login = stored;
			return stored;
		}
		const viewer = await this.gh.viewer();
		const login = viewer.login ?? "";
		if (login === "") throw new Error("gh is not signed in: it answered no login for the agent's account");
		this.login = login;
		this.scope?.setPosition(POSITION.self, login);
		return login;
	}

	private cursor(key: string, fallback: Ms): Ms {
		const stored = this.scope?.position(key);
		if (typeof stored === "number") return stored;
		if (typeof stored === "string") {
			const parsed = Number(stored);
			if (Number.isFinite(parsed)) return parsed;
		}
		return fallback;
	}

	/** A read position moves forward only: anything read twice is dropped as a duplicate. */
	private advance(key: string, at: Ms): void {
		this.scope?.setPosition(key, Math.max(this.cursor(key, at), at));
	}

	private at(value: string | null | undefined): Ms | undefined {
		const at = Date.parse(value ?? "");
		return Number.isFinite(at) ? at : undefined;
	}
}

// ------------------------------------------------------------------ triggers

interface CommentTarget {
	repo: string;
	number: number;
	isPr: boolean;
}

function threadOf(number: number, isPr: boolean): ThreadKey {
	return isPr ? pullThread(number) : `issue:${number}`;
}

function conversationOf(repo: string, number: number, isPr: boolean): string {
	return `${isPr ? "pr" : "issue"}:${repo}#${number}`;
}

function commentTrigger(target: CommentTarget, comment: GhComment, at: Ms): Trigger | undefined {
	const id = comment.id;
	if (id === undefined) return undefined;
	const kind = target.isPr ? "pr_comment" : "issue_comment";
	return {
		id: `${SOURCE}:${kind}:${id}`,
		source: SOURCE,
		kind,
		externalId: `${kind}:${id}`,
		at,
		actor: actorOf(comment.user),
		threads: [threadOf(target.number, target.isPr)],
		correlations: [],
		channel: { conversation: conversationOf(target.repo, target.number, target.isPr) },
		text: bounded(comment.body ?? "") || "(a comment with no text)",
		payload: { number: target.number, isPr: target.isPr, url: comment.html_url ?? undefined },
	};
}

function reviewTrigger(target: CommentTarget, review: GhReview, at: Ms): Trigger | undefined {
	const id = review.id;
	if (id === undefined) return undefined;
	const state = review.state ?? "COMMENTED";
	const decided = state === "COMMENTED" ? "" : `${state} review`;
	return {
		id: `${SOURCE}:pr_review:${id}`,
		source: SOURCE,
		kind: "pr_review",
		externalId: `pr_review:${id}`,
		at,
		actor: actorOf(review.user),
		threads: [pullThread(target.number)],
		correlations: [`review:${id}`],
		channel: { conversation: conversationOf(target.repo, target.number, true) },
		text: bounded([decided, review.body ?? ""].filter((part) => part !== "").join("\n\n")) || `${state} review`,
		payload: { number: target.number, isPr: true, reviewId: id, state, url: review.html_url ?? undefined },
	};
}

function reviewCommentTrigger(target: CommentTarget, comment: GhComment, root: number, at: Ms): Trigger | undefined {
	const id = comment.id;
	if (id === undefined) return undefined;
	const line = comment.line ?? comment.original_line;
	const place = comment.path === undefined || comment.path === null
		? ""
		: `${comment.path}${line === undefined || line === null ? "" : `:${line}`}`;
	return {
		id: `${SOURCE}:pr_review_comment:${id}`,
		source: SOURCE,
		kind: "pr_review_comment",
		externalId: `pr_review_comment:${id}`,
		at,
		actor: actorOf(comment.user),
		threads: [pullThread(target.number)],
		correlations: [`review:${root}`],
		channel: { conversation: conversationOf(target.repo, target.number, true), ref: `review-thread:${root}` },
		text: bounded([place, comment.body ?? ""].filter((part) => part !== "").join("\n\n")) || "(a review comment)",
		payload: { number: target.number, isPr: true, commentId: id, root },
	};
}

function openedTrigger(
	repo: string,
	kind: "issue_opened" | "pr_opened",
	number: number,
	isPr: boolean,
	opened: { title?: string; body?: string; user?: GhUser | null; url?: string; branch?: string },
	at: Ms,
): Trigger {
	return {
		id: `${SOURCE}:${kind}:${number}`,
		source: SOURCE,
		kind,
		externalId: `${kind}:${number}`,
		at,
		actor: actorOf(opened.user),
		threads: [threadOf(number, isPr)],
		correlations: [],
		channel: { conversation: conversationOf(repo, number, isPr) },
		text: bounded([opened.title ?? "", opened.body ?? ""].filter((part) => part !== "").join("\n\n")) || `#${number}`,
		payload: { number, isPr, branch: opened.branch, url: opened.url },
	};
}

function closeTrigger(repo: string, number: number, pull: GhPull, outcome: PullOutcome): Trigger {
	const kind = outcome.outcome === "merged" ? "pull_merged" : "pull_closed";
	const actor = outcome.outcome === "merged" ? actorOf(pull.merged_by) : GITHUB;
	const title = pull.title === undefined ? "" : ` ${pull.title}`;
	const text = outcome.outcome === "merged"
		? `Pull request #${number}${title} was merged.`
		: `Pull request #${number}${title} was closed without merging.`;
	return {
		id: `${SOURCE}:${kind}:${number}`,
		source: SOURCE,
		kind,
		externalId: `pull:${number}:${outcome.outcome}`,
		at: outcome.at,
		actor: actor.bot || actor.id === "" ? GITHUB : actor,
		threads: [pullThread(number)],
		correlations: [],
		channel: { conversation: conversationOf(repo, number, true) },
		text,
		payload: { number, isPr: true, outcome: outcome.outcome, url: pull.html_url },
	};
}

function ciTrigger(repo: string, state: CiState, at: Ms, where: { number?: number; branch?: string }): Trigger {
	const ids = ciFailureIds(state);
	// The sha and the failing check ids are GitHub's: the same failure state always reads the same.
	const externalId = `ci:${state.sha}:${ids.length === 0 ? "passed" : ids.join("-")}`;
	const on = where.number === undefined
		? `the default branch ${where.branch ?? ""}`.trim()
		: `pull request #${where.number}`;
	const channel: ChannelAddress = where.number === undefined
		? { conversation: `ci:${repo}@${state.sha}` }
		: { conversation: conversationOf(repo, where.number, true) };
	return {
		id: `${SOURCE}:${externalId}`,
		source: SOURCE,
		kind: "ci",
		externalId,
		at,
		actor: GITHUB,
		threads: where.number === undefined ? [`ci:${state.sha}`] : [pullThread(where.number)],
		correlations: where.number === undefined ? [] : [`ci:${state.sha}`],
		channel,
		text: ciSummary(state, on, where.number === undefined ? `github/commits/${state.sha}/checks` : `github/pulls/${where.number}/checks`),
		payload: {
			sha: state.sha,
			failed: state.failed.map((item) => item.name),
			running: state.running,
			number: where.number,
			branch: where.branch,
		},
	};
}

function notificationTrigger(
	repo: string,
	item: GhNotification,
	target: { number: number; pr: boolean },
	at: Ms,
): Trigger {
	const reason = item.reason ?? "subscribed";
	const title = item.subject?.title ?? "";
	const filtered: Filtered = { code: "no_actor", values: { reason } };
	return {
		id: `${SOURCE}:notification:${item.id ?? `${target.number}`}`,
		source: SOURCE,
		kind: "notification",
		externalId: `notification:${item.id ?? `${target.number}:${reason}`}`,
		at: Number.isFinite(Date.parse(item.updated_at ?? "")) ? Date.parse(item.updated_at ?? "") : at,
		actor: GITHUB,
		threads: [threadOf(target.number, target.pr)],
		correlations: [],
		channel: { conversation: conversationOf(repo, target.number, target.pr) },
		// GitHub notifications name no person, so the Source records them and lets nothing start on them.
		text: bounded(`#${target.number} ${title}`.trim()) || `#${target.number}`,
		filtered,
		payload: { number: target.number, isPr: target.pr, reason },
	};
}

// ------------------------------------------------------------------- values

function actorOf(user: GhUser | null | undefined): Actor {
	const login = user?.login ?? "";
	const name = user?.name;
	return { id: login, bot: isBot(user), ...(typeof name === "string" && name !== "" ? { name } : {}) };
}

/** GitHub reports a deleted account as null; a GitHub App and a `[bot]` login are bots. */
function isBot(user: GhUser | null | undefined): boolean {
	if (user === null || user === undefined) return true;
	if (/\[bot\]$/i.test(user.login ?? "")) return true;
	const type = user.type ?? "User";
	return type !== "User";
}

function bounded(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= MAX_TEXT ? trimmed : `${trimmed.slice(0, MAX_TEXT)}…`;
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function userOf(value: unknown): GhUser | undefined {
	return isRecord(value) ? (value as GhUser) : undefined;
}

function userLogin(value: unknown): string | undefined {
	return isRecord(value) ? stringValue(value.login) : undefined;
}

/** The Issue or PR number a GitHub URL names. */
function numberIn(url: string): number | undefined {
	const match = /\/(?:issues|pulls?)\/(\d+)(?:$|[/#?])/.exec(url);
	const number = match?.[1] === undefined ? Number.NaN : Number(match[1]);
	return Number.isFinite(number) ? number : undefined;
}

function isPullUrl(url: string): boolean {
	return /\/(?:pull|pulls)\/\d+/.test(url);
}

/** `https://api.github.com/repos/owner/repo/issues/12` or `.../pulls/12`, for a watched repository. */
function addressOf(url: string, repo: string): { number: number; pr: boolean } | undefined {
	const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)$/i.exec(url);
	if (match === null) return undefined;
	const name = match[1];
	const number = Number(match[3]);
	if (name === undefined || !sameName(name, repo) || !Number.isFinite(number)) return undefined;
	return { number, pr: match[2]?.toLowerCase() !== "issues" };
}

/** A conversation the Source writes to: `issue:owner/name#12` or `pr:owner/name#12`. */
function conversationAt(conversation: string): { repo: string; number: number; isPr: boolean } | undefined {
	const match = /^(issue|pr):([^#@]+)#(\d+)$/.exec(conversation);
	if (match === null) return undefined;
	const number = Number(match[3]);
	if (!Number.isFinite(number)) return undefined;
	return { repo: match[2] ?? "", number, isPr: match[1] === "pr" };
}

/** The root review comment a `review-thread:<id>` write replies to. */
function reviewRoot(ref: string | undefined): number | undefined {
	const match = /^review-thread:(\d+)$/.exec(ref ?? "");
	const root = match?.[1] === undefined ? Number.NaN : Number(match[1]);
	return Number.isFinite(root) ? root : undefined;
}
