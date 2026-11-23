import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJournal, readJournal } from "../src/infra/journal.js";
import { createLock } from "../src/infra/lock.js";
import { createPaths, defaultStateRoot } from "../src/infra/paths.js";
import { createInitialState, openStore } from "../src/infra/store.js";
import { makeTicket } from "../src/testing/fakes.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sagent-store-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const files = (): { stateFile: string; journalFile: string } => ({
	stateFile: join(dir, "state.json"),
	journalFile: join(dir, "journal.jsonl"),
});

describe("createInitialState", () => {
	it("starts empty, with the default policy and zeroed ids", () => {
		const state = createInitialState();
		expect(state.version).toBe(1);
		expect(state.triggers).toEqual({});
		expect(state.tickets).toEqual({});
		expect(state.assignments).toEqual({});
		expect(state.problems).toEqual([]);
		expect(state.seq).toEqual({ trigger: 0, eval: 0, decision: 0, ticket: 0, assignment: 0, input: 0 });
		expect(state.policy.version).toBe(1);
		expect(state.policy.acceptMode).toBe("off");
		expect(state.policy.rules).toEqual([]);
		expect(Object.keys(state.policy.sources)).toEqual(["github"]);
		expect(state.policy.sources.github).toEqual({
			enabled: false,
			repository: "",
			allowedActors: [],
			botActors: [],
			watchAll: false,
			pollMs: 60_000,
		});
	});
});

describe("paths", () => {
	it("roots the state directory at PI_SUPERAGENT_DIR or the home default", () => {
		expect(defaultStateRoot({ PI_SUPERAGENT_DIR: "/tmp/state" })).toBe("/tmp/state");
		expect(defaultStateRoot({})).toMatch(/\.pi[/\\]superagent$/);
	});

	it("expands a leading tilde in the override", () => {
		expect(defaultStateRoot({ PI_SUPERAGENT_DIR: "~/sagent" })).toBe(join(homedir(), "sagent"));
	});

	it("names every file and directory the design lists", () => {
		const paths = createPaths(dir);
		expect(paths.stateFile).toBe(join(dir, "state.json"));
		expect(paths.journalFile).toBe(join(dir, "journal.jsonl"));
		expect(paths.lockFile).toBe(join(dir, "lock"));
		expect(paths.settingsFile).toBe(join(dir, "settings.json"));
		expect(paths.effectsFile).toBe(join(dir, "effects.jsonl"));
		expect(paths.socketFile).toBe(join(dir, "superagent.sock"));
		expect(paths.workDir).toBe(join(dir, "work"));
		expect(paths.sessionsDir).toBe(join(dir, "sessions"));
		expect(paths.inboxDir).toBe(join(dir, "inbox"));
		expect(paths.ticketDir("tkt-1")).toBe(join(dir, "work", "tkt-1"));
		expect(paths.sessionDir("tkt-1")).toBe(join(dir, "sessions", "tkt-1"));
		expect(paths.inboxFile("tkt-1")).toBe(join(dir, "inbox", "tkt-1.jsonl"));
	});

	it("creates the state directory and its subdirectories", () => {
		const paths = createPaths(join(dir, "nested"));
		paths.ensureDirs();
		paths.ensureDirs();
		expect(existsSync(paths.workDir)).toBe(true);
		expect(existsSync(paths.sessionsDir)).toBe(true);
		expect(existsSync(paths.inboxDir)).toBe(true);
	});
});

describe("store", () => {
	it("opens with the initial state when there is no snapshot", () => {
		const store = openStore(files());
		expect(store.state.version).toBe(1);
		expect(store.state.tickets).toEqual({});
	});

	it("persists a transaction and reads it back", () => {
		const store = openStore(files());
		const wrote = store.tx("createTicket", (state) => {
			state.seq.ticket += 1;
			state.tickets["tkt-1"] = makeTicket({ id: "tkt-1" });
			return state.seq.ticket;
		});
		expect(wrote).toBe(1);
		const reopened = openStore(files());
		expect(Object.keys(reopened.state.tickets)).toEqual(["tkt-1"]);
		expect(reopened.state.seq.ticket).toBe(1);
	});

	it("writes the snapshot by rename, leaving no temporary file behind", () => {
		const store = openStore(files());
		store.tx("pause", (state) => {
			state.pausedAt = 7;
		});
		expect(existsSync(files().stateFile)).toBe(true);
		expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("rolls back the in-memory state when the mutation throws", () => {
		const store = openStore(files());
		store.tx("pause", (state) => {
			state.pausedAt = 5;
		});
		const before = readFileSync(files().stateFile, "utf8");
		expect(() =>
			store.tx("resume", (state) => {
				state.pausedAt = undefined;
				state.seq.ticket = 99;
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(store.state.pausedAt).toBe(5);
		expect(store.state.seq.ticket).toBe(0);
		expect(readFileSync(files().stateFile, "utf8")).toBe(before);
	});

	it("keeps a nested aggregate intact after a rollback", () => {
		const store = openStore(files());
		store.tx("policy", (state) => {
			state.policy.sources.github.repository = "owner/repo";
		});
		expect(() =>
			store.tx("policy", (state) => {
				state.policy.sources.github.repository = "other/repo";
				state.policy.sources.github.allowedActors.push("eve");
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(store.state.policy.sources.github.repository).toBe("owner/repo");
		expect(store.state.policy.sources.github.allowedActors).toEqual([]);
	});

	it("appends one journal entry per committed transaction", () => {
		const store = openStore({ ...files(), clock: () => 4242 });
		store.tx("createTicket", (state) => {
			state.seq.ticket += 1;
		}, { ticket: "tkt-1" });
		store.tx("createTicket", (state) => {
			state.seq.ticket += 1;
		}, { ticket: "tkt-2" });
		const entries = readJournal(files().journalFile);
		expect(entries).toEqual([
			{ at: 4242, cmd: "createTicket", detail: { ticket: "tkt-1" } },
			{ at: 4242, cmd: "createTicket", detail: { ticket: "tkt-2" } },
		]);
	});

	it("journals nothing for a rolled back transaction", () => {
		const store = openStore(files());
		expect(() =>
			store.tx("createTicket", () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(readJournal(files().journalFile)).toEqual([]);
	});

	it("flushes without a journal entry", () => {
		const store = openStore(files());
		store.state.pausedAt = 11;
		store.flush();
		expect(openStore(files()).state.pausedAt).toBe(11);
		expect(readJournal(files().journalFile)).toEqual([]);
	});

	it("starts fresh from an unreadable snapshot and keeps the broken file", () => {
		writeFileSync(files().stateFile, "{not json");
		const store = openStore({ ...files(), clock: () => 1_700 });
		expect(store.state.tickets).toEqual({});
		expect(existsSync(`${files().stateFile}.corrupt-1700`)).toBe(true);
		expect(readFileSync(`${files().stateFile}.corrupt-1700`, "utf8")).toBe("{not json");
	});
});

describe("journal", () => {
	it("reads the last entries in time order", () => {
		const journal = createJournal(join(dir, "journal.jsonl"), () => 1);
		for (let index = 0; index < 5; index += 1) journal.append(`cmd${index}`);
		expect(readJournal(join(dir, "journal.jsonl"), 2).map((entry) => entry.cmd)).toEqual(["cmd3", "cmd4"]);
		expect(readJournal(join(dir, "journal.jsonl"), 0)).toEqual([]);
		expect(readJournal(join(dir, "journal.jsonl")).length).toBe(5);
	});

	it("skips a malformed line and never throws on an unwritable path", () => {
		const file = join(dir, "journal.jsonl");
		writeFileSync(file, `${JSON.stringify({ at: 1, cmd: "a" })}\nnot json\n`);
		expect(readJournal(file).map((entry) => entry.cmd)).toEqual(["a"]);
		expect(() => createJournal(join(dir, "missing", "journal.jsonl")).append("a")).not.toThrow();
		expect(readJournal(join(dir, "missing", "journal.jsonl"))).toEqual([]);
	});
});

describe("lock", () => {
	const deadPid = (): number => {
		const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		if (child.pid === undefined) throw new Error("the probe process has no pid");
		return child.pid;
	};

	it("acquires a free lock, reports the holder and releases it", () => {
		const file = join(dir, "lock");
		const lock = createLock(file, () => 1000);
		expect(lock.probe()).toBeNull();
		const release = lock.acquire("session-1");
		expect(release).toBeTypeOf("function");
		expect(lock.probe()).toEqual({ pid: process.pid, startedAt: 1000, sessionId: "session-1" });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			pid: process.pid,
			startedAt: 1000,
			sessionId: "session-1",
		});
		release?.();
		release?.();
		expect(existsSync(file)).toBe(false);
		expect(lock.probe()).toBeNull();
	});

	it("refuses while a live process holds it", () => {
		const file = join(dir, "lock");
		const first = createLock(file);
		const release = first.acquire("session-1");
		expect(createLock(file).acquire("session-2")).toBeUndefined();
		expect(createLock(file).probe()?.sessionId).toBe("session-1");
		release?.();
	});

	it("takes over a stale lock whose holder is gone", () => {
		const file = join(dir, "lock");
		writeFileSync(file, JSON.stringify({ pid: deadPid(), startedAt: 1, sessionId: "gone" }));
		const lock = createLock(file);
		expect(lock.probe()).toBeNull();
		const release = lock.acquire("session-2");
		expect(release).toBeTypeOf("function");
		expect(lock.probe()?.sessionId).toBe("session-2");
		release?.();
	});

	it("treats a corrupt lock file as stale", () => {
		const file = join(dir, "lock");
		for (const raw of ["{not json", JSON.stringify({ hello: "world" }), JSON.stringify({ pid: "1" })]) {
			writeFileSync(file, raw);
			const lock = createLock(file);
			expect(lock.probe()).toBeNull();
			const release = lock.acquire("session-3");
			expect(release).toBeTypeOf("function");
			release?.();
		}
	});

	it("fails loudly when the state directory is missing", () => {
		expect(() => createLock(join(dir, "missing", "lock")).acquire("session-4")).toThrow();
	});
});
