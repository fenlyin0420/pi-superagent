/**
 * The append-only audit log. One line per domain command, best effort: a journal
 * that cannot be written must never break a command that already committed.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { Ms } from "../core/model.js";
import type { JournalEntry } from "../core/ports.js";

export interface Journal {
	readonly file: string;
	/** Append one entry. Never throws. */
	append(cmd: string, detail?: Record<string, unknown>): void;
}

export function createJournal(file: string, clock: () => Ms = Date.now): Journal {
	return {
		file,
		append(cmd: string, detail?: Record<string, unknown>): void {
			const entry: JournalEntry = detail === undefined ? { at: clock(), cmd } : { at: clock(), cmd, detail };
			try {
				appendFileSync(file, `${JSON.stringify(entry)}\n`);
			} catch {
				/* The snapshot is the authority; a lost audit line is not worth failing over. */
			}
		},
	};
}

/** The most recent `limit` entries in time order, for the panel. */
export function readJournal(file: string, limit?: number): JournalEntry[] {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries: JournalEntry[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		const entry = parse(line);
		if (entry) entries.push(entry);
	}
	if (limit === undefined || limit >= entries.length) return entries;
	return limit <= 0 ? [] : entries.slice(-limit);
}

function parse(line: string): JournalEntry | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const entry = value as Record<string, unknown>;
	if (typeof entry.at !== "number" || typeof entry.cmd !== "string") return null;
	const detail = entry.detail;
	if (detail !== undefined && (typeof detail !== "object" || detail === null)) return null;
	return detail === undefined
		? { at: entry.at, cmd: entry.cmd }
		: { at: entry.at, cmd: entry.cmd, detail: detail as Record<string, unknown> };
}
