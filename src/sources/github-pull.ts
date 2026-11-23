/**
 * Pull request tracking (docs/000-design.md "GitHub source"): which pull requests
 * a Ticket follows, which Ticket a pull request belongs to, and whether it ended
 * merged or closed. The Source reads these; Tickets alone writes `follows`.
 */
import type { Ms, ThreadKey, Ticket, TicketId } from "../core/model.js";
import type { GhCli, GhPull } from "./github-read.js";
import { sameName } from "./github-read.js";

/** The Thread of a pull request. */
export function pullThread(number: number): ThreadKey {
	return `pr:${number}`;
}

/** The number a `pr:` Thread names; undefined for any other Thread. */
export function pullNumber(thread: ThreadKey): number | undefined {
	const match = /^pr:(\d+)$/.exec(thread);
	const number = match?.[1] === undefined ? Number.NaN : Number(match[1]);
	return Number.isFinite(number) ? number : undefined;
}

/** The part of a Ticket pull tracking reads: its identity and the Threads it follows. */
export type TrackedTicket = Pick<Ticket, "id" | "execution" | "follows">;

/** The pull requests a Ticket follows, in the order it began following them. */
export function pullsOf(ticket: Pick<Ticket, "follows">, options: { openOnly?: boolean } = {}): number[] {
	const numbers: number[] = [];
	for (const followed of ticket.follows ?? []) {
		if (options.openOnly === true && followed.closed !== undefined) continue;
		const number = pullNumber(followed.thread);
		if (number !== undefined) numbers.push(number);
	}
	return numbers;
}

/** 003: a branch belongs to a Ticket when its last path segment is the Ticket's short name, as in `agent/<name>`. */
export function ticketBranch(ticket: Pick<Ticket, "execution">, ref: string): boolean {
	const name = ticket.execution?.name ?? "";
	return name !== "" && ref.split("/").at(-1) === name;
}

/** True when the agent opened the pull request from a branch of the watched repository, not a fork. */
export function agentPull(pull: GhPull, repo: string, login: string): boolean {
	if (!sameName(pull.user?.login ?? "", login)) return false;
	const head = pull.head?.repo?.full_name;
	return head === undefined ? false : sameName(head, repo);
}

/** The open Ticket a pull request belongs to: the agent's own pull request from that Ticket's branch. */
export function claimPull(
	pull: GhPull,
	repo: string,
	login: string,
	tickets: readonly TrackedTicket[],
): TrackedTicket | undefined {
	if (!agentPull(pull, repo, login)) return undefined;
	const ref = pull.head?.ref ?? "";
	const matches = tickets.filter((ticket) => ticketBranch(ticket, ref));
	// One branch may name several Tickets (a resumed name); only an unambiguous match binds.
	return matches.length === 1 ? matches[0] : undefined;
}

export interface PullOutcome {
	outcome: "merged" | "closed";
	at: Ms;
}

/** The merged or closed outcome of a pull request, or undefined while it is open. */
export function pullOutcome(pull: GhPull): PullOutcome | undefined {
	const merged = pull.merged === true;
	if (!merged && pull.state !== "closed") return undefined;
	const at = Date.parse((merged ? pull.merged_at : pull.closed_at) ?? pull.closed_at ?? pull.merged_at ?? "");
	return { outcome: merged ? "merged" : "closed", at: Number.isFinite(at) ? at : Date.now() };
}

/** One pull request read over `gh`, with the Thread it belongs to and the Ticket it may bind to. */
export interface TrackedPull {
	number: number;
	thread: ThreadKey;
	pull: GhPull;
	/** The Ticket that owns it, when the agent opened it from a Ticket's branch. */
	claim?: TrackedTicket;
	outcome?: PullOutcome;
}

/**
 * Reads one pull request and answers the tracking facts the Source acts on. A
 * pull request GitHub no longer serves (404 or 410) reads as gone: the caller
 * drops it from the round instead of failing the poll.
 */
export async function pullOf(
	gh: GhCli,
	repo: string,
	number: number,
	login: string,
	tickets: readonly TrackedTicket[] = [],
): Promise<TrackedPull | undefined> {
	let pull: GhPull;
	try {
		pull = await gh.pull(repo, number);
	} catch (error) {
		const status = (error as { status?: number }).status;
		if (status === 404 || status === 410) return undefined;
		throw error;
	}
	const tracked: TrackedPull = { number, thread: pullThread(number), pull };
	const outcome = pullOutcome(pull);
	if (outcome !== undefined) tracked.outcome = outcome;
	const claim = claimPull(pull, repo, login, tickets);
	if (claim !== undefined) tracked.claim = claim;
	return tracked;
}

/** The head commit of an open pull request, which is what its CI is read for. */
export function pullHead(pull: GhPull): string | undefined {
	const sha = pull.head?.sha;
	return sha === undefined || sha === "" ? undefined : sha;
}

/** The Tickets a set of pull requests binds: one Ticket per pull request, and none already following an open one. */
export function bindings(tracked: readonly TrackedPull[]): Array<{ ticketId: TicketId; number: number }> {
	const bound: Array<{ ticketId: TicketId; number: number }> = [];
	for (const item of tracked) {
		if (item.outcome !== undefined || item.claim === undefined) continue;
		if (pullsOf(item.claim, { openOnly: true }).length > 0) continue;
		bound.push({ ticketId: item.claim.id, number: item.number });
	}
	return bound;
}
