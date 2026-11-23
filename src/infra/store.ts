/**
 * The snapshot store: the live aggregate graph in memory, persisted as one JSON
 * file written atomically, with one journal line per domain command.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ms, State } from "../core/model.js";
import type { Store } from "../core/ports.js";
import { createJournal, type Journal } from "./journal.js";

export interface StoreOptions {
	stateFile: string;
	journalFile: string;
	clock?: () => Ms;
}

export class SnapshotStore implements Store {
	readonly state: State;
	private readonly stateFile: string;
	private readonly journal: Journal;
	private readonly clock: () => Ms;

	constructor(options: StoreOptions) {
		this.stateFile = options.stateFile;
		this.clock = options.clock ?? Date.now;
		this.journal = createJournal(options.journalFile, this.clock);
		mkdirSync(dirname(options.stateFile), { recursive: true });
		this.state = this.load();
	}

	tx<T>(cmd: string, mutate: (state: State) => T, detail?: Record<string, unknown>): T {
		const snapshot = structuredClone(this.state);
		let result: T;
		try {
			result = mutate(this.state);
		} catch (error) {
			Object.assign(this.state, snapshot);
			throw error;
		}
		try {
			this.write();
		} catch (error) {
			Object.assign(this.state, snapshot);
			throw error;
		}
		// The journal is written after the snapshot: it records what committed.
		this.journal.append(cmd, detail);
		return result;
	}

	flush(): void {
		this.write();
	}

	private write(): void {
		const temporary = `${this.stateFile}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.state)}\n`);
		try {
			renameSync(temporary, this.stateFile);
		} catch (error) {
			removeQuietly(temporary);
			throw error;
		}
	}

	private load(): State {
		let raw: string;
		try {
			raw = readFileSync(this.stateFile, "utf8");
		} catch {
			return createInitialState();
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			value = undefined;
		}
		if (isState(value)) return value;
		// Keep the unreadable snapshot instead of overwriting it on the next write.
		try {
			renameSync(this.stateFile, `${this.stateFile}.corrupt-${this.clock()}`);
		} catch {
			/* Reading it failed and moving it failed too; the initial state stands. */
		}
		return createInitialState();
	}
}

export function openStore(options: StoreOptions): SnapshotStore {
	return new SnapshotStore(options);
}

export function createInitialState(): State {
	return {
		version: 1,
		sources: {},
		triggers: {},
		dispositions: {},
		threads: {},
		evals: {},
		decisions: {},
		tickets: {},
		assignments: {},
		policy: {
			version: 1,
			acceptMode: "off",
			rules: [],
			sources: {
				github: {
					enabled: false,
					repository: "",
					allowedActors: [],
					botActors: [],
					watchAll: false,
					pollMs: 60_000,
				},
			},
			updatedAt: 0,
		},
		seq: { trigger: 0, eval: 0, decision: 0, ticket: 0, assignment: 0, input: 0 },
		problems: [],
	};
}

function isState(value: unknown): value is State {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.policy)) return false;
	const collections = [
		"sources",
		"triggers",
		"dispositions",
		"threads",
		"evals",
		"decisions",
		"tickets",
		"assignments",
		"seq",
	];
	return collections.every((name) => isRecord(value[name])) && Array.isArray(value.problems);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeQuietly(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		/* Nothing to remove. */
	}
}
