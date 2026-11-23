import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Assignment, Input, Ms, State, Ticket, TicketId, Trigger } from "../src/core/model.js";
import type { OutboundMessage, RouterMessage, Source as SourcePort, SourceScope } from "../src/core/ports.js";
import type { DomainEvent } from "../src/core/part.js";
import { createLock } from "../src/infra/lock.js";
import { openStore, type SnapshotStore } from "../src/infra/store.js";
import { defaultSettings, type Settings } from "../src/app/settings.js";
import { NO_HOST, Runtime, wireDecode, wireEncode, type RuntimeOptions } from "../src/app/runtime.js";
import {
	FakeAssessor,
	FakeExecutor,
	acceptVerdict,
	makeAssignment,
	makeTicket,
	makeTrigger,
} from "../src/testing/fakes.js";

const NOW: Ms = 1_000_000;

// ------------------------------------------------------------------ fixtures

const dirs: string[] = [];
const running: Runtime[] = [];

afterEach(async () => {
	for (const runtime of running.splice(0)) await runtime.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "sagent-runtime-"));
	dirs.push(dir);
	return dir;
}

function allowWork(settings: Settings): void {
	settings.policy.acceptMode = "explicit";
	settings.policy.sources.github = {
		enabled: true,
		repository: "owner/repo",
		allowedActors: ["alice"],
		botActors: [],
		watchAll: false,
		pollMs: 60_000,
	};
}

function writeSettings(dir: string, patch: (settings: Settings) => void = () => {}): void {
	const settings = defaultSettings({ workRoot: join(dir, "work"), clock: () => NOW });
	patch(settings);
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
}

function storeAt(dir: string): SnapshotStore {
	return openStore({ stateFile: join(dir, "state.json"), journalFile: join(dir, "journal.jsonl"), clock: () => NOW });
}

class FakeSource implements SourcePort {
	readonly id = "github";
	scope?: SourceScope;
	readonly posts: OutboundMessage[] = [];
	polls = 0;
	listed = true;

	start(scope: SourceScope): void {
		this.scope = scope;
	}

	async stop(): Promise<void> {
		this.scope = undefined;
	}

	async poll(): Promise<void> {
		this.polls += 1;
	}

	status(): { lastPollAt?: Ms; lastError?: { at: Ms; message: string } } {
		return this.polls === 0 ? {} : { lastPollAt: NOW + this.polls };
	}

	/** Outbox: the channel this source writes to. */
	listens(conversation: string): boolean {
		return this.listed && conversation.startsWith("issue:");
	}

	async post(message: OutboundMessage): Promise<string> {
		this.posts.push(message);
		return `comment-${this.posts.length}`;
	}

	receive(trigger: Trigger): void {
		if (this.scope === undefined) throw new Error("The fake source was not started");
		this.scope.receive(trigger);
	}
}

interface Seed {
	id: TicketId;
	createdAt: Ms;
	name?: string;
	thread?: string;
	attention?: boolean;
	ended?: boolean;
	/** The latest assignment: running, pending, or none at all. */
	assignment?: "running" | "pending";
}

function seedTicket(state: State, options: Seed): Ticket {
	const name = options.name ?? options.id;
	const ticket = makeTicket({ id: options.id, name, createdAt: options.createdAt, thread: options.thread ?? "issue:1" });
	ticket.execution = { name, directory: join(tmpdir(), name) };
	if (options.attention === true) ticket.attention = { question: "Which branch should this go to?", at: options.createdAt };
	if (options.ended === true) {
		ticket.ended = { at: options.createdAt + 10, by: "executor", reason: "completed", outcome: "completed" };
	}
	state.tickets[ticket.id] = ticket;
	if (options.assignment !== undefined) {
		const assignment: Assignment = makeAssignment(ticket, {
			id: `${ticket.id}-asg`,
			state: options.assignment,
			startedAt: options.createdAt,
		});
		state.assignments[assignment.id] = assignment;
		ticket.assignmentIds = [assignment.id];
		ticket.execution.assignmentId = assignment.id;
	}
	return ticket;
}

interface Host {
	dir: string;
	runtime: Runtime;
	source: FakeSource;
	executor: FakeExecutor;
	store: SnapshotStore;
}

async function host(options: { patch?: (settings: Settings) => void; seed?: (state: State) => void; extra?: RuntimeOptions } = {}): Promise<Host> {
	const dir = workspace();
	writeSettings(dir, options.patch ?? allowWork);
	const store = storeAt(dir);
	if (options.seed !== undefined) store.tx("seed", (state) => options.seed?.(state));
	const source = new FakeSource();
	const executor = new FakeExecutor();
	const runtime = new Runtime({
		stateDir: dir,
		store,
		source,
		executor,
		now: () => NOW,
		random: () => 0.5,
		passIntervalMs: 3_600_000,
		passJitterMs: 1,
		socketTimeoutMs: 2_000,
		...options.extra,
	});
	running.push(runtime);
	const started = await runtime.start();
	if (!started.ok) throw new Error(started.error);
	expect(started.role).toBe("host");
	return { dir, runtime, source, executor, store };
}

function inputsOf(store: SnapshotStore, ticketId: TicketId): Input[] {
	return store.state.tickets[ticketId]?.inputs ?? [];
}

// --------------------------------------------------------------------- tests

describe("host", () => {
	it("reports the panel's rows and the overview from the state it hosts", async () => {
		const h = await host({
			seed: (state) => {
				seedTicket(state, { id: "ticket-1", createdAt: 10, attention: true, assignment: "running" });
				seedTicket(state, { id: "ticket-2", createdAt: 20, assignment: "running" });
				seedTicket(state, { id: "ticket-3", createdAt: 30, ended: true });
			},
		});
		await h.runtime.idle();

		const rows = await h.runtime.rows();
		if (!rows.ok) throw new Error(rows.error);
		// A person's row comes before work in progress, and an ended ticket has none.
		expect(rows.value.map((row) => row.id).sort()).toEqual(["ticket-1", "ticket-2"]);
		expect(rows.value[0]).toMatchObject({ stage: { kind: "person", code: "answer" }, label: "Awaiting answer" });
		expect(rows.value[0]?.scope).toBe("fix the flaky upload test");

		const overview = await h.runtime.overview();
		if (!overview.ok) throw new Error(overview.error);
		expect(overview.value.policyVersion).toBe(1);
		expect(overview.value.paused).toBe(false);
		expect(overview.value.host?.pid).toBe(process.pid);
		expect(overview.value.sources.map((source) => source.id)).toEqual(["github"]);

		const detail = await h.runtime.openTicket({ ticketId: "ticket-3" });
		if (!detail.ok) throw new Error(detail.error);
		expect(detail.value.ticket.ended?.outcome).toBe("completed");
	});

	it("restarts the assignment a previous host left running, oldest ticket first, and replays pending effects", async () => {
		const dir = workspace();
		writeSettings(dir);
		const store = storeAt(dir);
		store.tx("seed", (state) => {
			seedTicket(state, { id: "ticket-old", createdAt: 10, assignment: "running" });
			seedTicket(state, { id: "ticket-new", createdAt: 20, assignment: "running" });
			seedTicket(state, { id: "ticket-queued", createdAt: 30, assignment: "pending" });
		});
		// The queued ticket's launch was queued by the host that died before it could run.
		writeFileSync(
			join(dir, "effects.jsonl"),
			`${JSON.stringify({
				seq: 1,
				at: NOW,
				due: NOW,
				attempts: 0,
				effect: { kind: "launch", ticketId: "ticket-queued", assignmentId: "ticket-queued-asg" },
			})}\n`,
		);
		const source = new FakeSource();
		const executor = new FakeExecutor();
		const runtime = new Runtime({
			stateDir: dir,
			store,
			source,
			executor,
			now: () => NOW,
			random: () => 0.5,
			passIntervalMs: 3_600_000,
		});
		running.push(runtime);
		expect(await runtime.start()).toMatchObject({ ok: true, role: "host" });
		await runtime.idle();

		// Both running tickets start again with a recovery note the worker reads.
		expect(store.state.tickets["ticket-old"]?.assignmentIds).toHaveLength(2);
		expect(store.state.tickets["ticket-new"]?.assignmentIds).toHaveLength(2);
		expect(inputsOf(store, "ticket-old").map((input) => input.kind)).toEqual(["recovery"]);
		expect(inputsOf(store, "ticket-old")[0]?.text).toContain("host restarted");

		const restarted = executor.prepared.map((request) => request.ticket.id);
		expect(restarted.indexOf("ticket-old")).toBeLessThan(restarted.indexOf("ticket-new"));
		// The row the dead host left on disk ran too.
		expect(executor.launched.map((request) => request.ticket.id)).toContain("ticket-queued");
	});

	it("waits for a person's resume before it recovers a paused host's work", async () => {
		const h = await host({
			seed: (state) => {
				seedTicket(state, { id: "ticket-1", createdAt: 10, assignment: "running" });
				state.pausedAt = NOW;
			},
		});
		expect(h.store.state.tickets["ticket-1"]?.assignmentIds).toHaveLength(1);
		expect(inputsOf(h.store, "ticket-1")).toHaveLength(0);

		expect((await h.runtime.resume()).ok).toBe(true);
		await h.runtime.idle();

		expect(h.store.state.pausedAt).toBeUndefined();
		expect(h.store.state.tickets["ticket-1"]?.assignmentIds).toHaveLength(2);
		expect(inputsOf(h.store, "ticket-1").map((input) => input.kind)).toEqual(["recovery"]);
	});

	it("runs a Trigger from the source through the router to a prepared ticket", async () => {
		const h = await host();
		const messages: RouterMessage[] = [];
		const events: DomainEvent[] = [];
		h.runtime.onRouterMessage((message) => {
			messages.push(message);
		});
		h.runtime.onDomainEvent((event) => {
			events.push(event);
		});

		const trigger = makeTrigger({
			id: "trg-1",
			externalId: "comment-1",
			kind: "mention",
			threads: ["issue:1"],
			channel: { conversation: "issue:owner/repo#1" },
			text: "Please fix the flaky upload test.",
		});
		h.source.receive(trigger);
		await h.runtime.idle();

		const candidate = messages.find((message) => message.kind === "candidate");
		expect(candidate?.candidate?.triggerIds).toEqual(["trg-1"]);
		// The candidate reached the router session, so its deadline counts from now.
		const batch = Object.values(h.store.state.evals)[0];
		expect(batch?.candidateDeliveredAt).toBeDefined();
		expect(batch?.status).toBe("running");

		const decided = await h.runtime.decide({
			triggerId: "trg-1",
			outcome: "accept",
			basis: "a person asked for it",
			scope: "repair the flaky upload test",
		});
		expect(decided.ok).toBe(true);
		await h.runtime.idle();

		const ticket = Object.values(h.store.state.tickets)[0];
		expect(ticket?.mandate.scope).toBe("repair the flaky upload test");
		expect(ticket?.ended).toBeUndefined();
		expect(h.source.posts.map((message) => message.purpose)).toEqual(["acknowledgement"]);
		expect(h.executor.prepared.map((request) => request.ticket.id)).toEqual([ticket?.id]);
		expect(h.executor.launched.map((request) => request.ticket.id)).toEqual([ticket?.id]);
		expect(events.some((event) => event.type === "ticket.created")).toBe(true);

		const rows = await h.runtime.rows();
		if (!rows.ok) throw new Error(rows.error);
		expect(rows.value.map((row) => row.stage.code)).toEqual(["queued"]);

		const triggers = await h.runtime.triggers({ limit: 5 });
		if (!triggers.ok) throw new Error(triggers.error);
		expect(triggers.value[0]).toMatchObject({ id: "trg-1", kind: "mention", status: "evaluated" });
	});

	it("assesses a candidate with the configured Assessor when the caller asks for it", async () => {
		const assessor = new FakeAssessor(acceptVerdict("the requested work"));
		const h = await host({ extra: { assessor } });
		h.source.receive(makeTrigger({ id: "trg-1", kind: "mention", threads: ["issue:1"] }));
		await h.runtime.idle();

		const decided = await h.runtime.decide({ triggerId: "trg-1", assess: true });
		expect(decided).toMatchObject({ ok: true });
		expect(assessor.inputs).toHaveLength(1);
		expect(assessor.inputs[0]?.triggers.map((item) => item.id)).toEqual(["trg-1"]);
		expect(assessor.inputs[0]?.gate).toMatchObject({ admissible: true, strength: "explicit" });

		const ticket = Object.values(h.store.state.tickets)[0];
		expect(ticket?.mandate.scope).toBe("the requested work");
	});

	it("answers a failure, never an exception, for what a person cannot do", async () => {
		const h = await host();
		for (const result of [
			await h.runtime.attach({ ticketId: "ticket-404", triggerId: "trg-404" }),
			await h.runtime.note({ ticketId: "ticket-404", text: "anything" }),
			await h.runtime.stopTicket({ ticketId: "ticket-404" }),
			await h.runtime.openTicket({ ticketId: "ticket-404" }),
			await h.runtime.decide({ triggerId: "trg-404", outcome: "ignore" }),
		]) {
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected a failure");
			expect(result.code).toBeTruthy();
			expect(result.error).not.toBe("");
		}
		const unknown = await h.runtime.openTicket({ ticketId: "ticket-404" });
		expect(unknown).toMatchObject({ ok: false, code: "unknownTicket" });

		const noAssessor = await h.runtime.decide({ triggerId: "trg-404", assess: true });
		expect(noAssessor).toMatchObject({ ok: false });
	});
});

describe("client", () => {
	it("forwards its commands to the session that holds the state directory", async () => {
		const h = await host({
			seed: (state) => {
				seedTicket(state, { id: "ticket-1", createdAt: 10, assignment: "running" });
			},
		});

		const client = new Runtime({
			stateDir: h.dir,
			store: storeAt(h.dir),
			source: new FakeSource(),
			executor: new FakeExecutor(),
			now: () => NOW,
			random: () => 0.5,
			passIntervalMs: 3_600_000,
			socketTimeoutMs: 2_000,
		});
		running.push(client);
		expect(await client.start()).toMatchObject({ ok: true, role: "client" });
		expect(client.isHost()).toBe(false);

		const rows = await client.rows();
		if (!rows.ok) throw new Error(rows.error);
		expect(rows.value.map((row) => row.id)).toEqual(["ticket-1"]);

		expect((await client.pause()).ok).toBe(true);
		const overview = await h.runtime.overview();
		if (!overview.ok) throw new Error(overview.error);
		expect(overview.value.paused).toBe(true);

		// The host runs the command against its own state, so its refusal crosses the wire.
		const refused = await client.stopTicket({ ticketId: "ticket-404" });
		expect(refused).toMatchObject({ ok: false, code: "unknownTicket" });

		// Router messages are the host's: a client never sees them.
		const seen: RouterMessage[] = [];
		client.onRouterMessage((message) => {
			seen.push(message);
		});
		h.source.receive(makeTrigger({ id: "trg-1", kind: "mention", threads: ["issue:1"] }));
		await h.runtime.idle();
		await client.idle();
		expect(seen).toEqual([]);
	});

	it("says plainly that no host answered", async () => {
		const dir = workspace();
		writeSettings(dir);
		const lock = createLock(join(dir, "lock"), () => NOW);
		const release = lock.acquire("another session");
		expect(release).toBeDefined();
		const runtime = new Runtime({
			stateDir: dir,
			store: storeAt(dir),
			source: new FakeSource(),
			executor: new FakeExecutor(),
			now: () => NOW,
			socketTimeoutMs: 500,
		});
		running.push(runtime);
		try {
			expect(await runtime.start()).toMatchObject({ ok: true, role: "client" });
			const result = await runtime.stopTicket({ ticketId: "ticket-1" });
			expect(result).toMatchObject({ ok: false, code: NO_HOST });
			if (result.ok) throw new Error("expected a failure");
			expect(result.error).toContain("superagent.sock");
		} finally {
			release?.();
		}
	});

	it("takes the host role once the other holder is gone", async () => {
		const h = await host({
			seed: (state) => {
				seedTicket(state, { id: "ticket-1", createdAt: 10, assignment: "running" });
			},
		});
		const client = new Runtime({
			stateDir: h.dir,
			source: new FakeSource(),
			executor: new FakeExecutor(),
			now: () => NOW,
			passIntervalMs: 3_600_000,
			socketTimeoutMs: 2_000,
		});
		running.push(client);
		expect(await client.start()).toMatchObject({ ok: true, role: "client" });
		// What the host writes after the client started is what the client must find when it takes over.
		expect((await h.runtime.note({ ticketId: "ticket-1", text: "the host's own note" })).ok).toBe(true);
		await h.runtime.stop();
		expect(await client.acquireHost()).toBe(true);
		expect(client.isHost()).toBe(true);

		const detail = await client.openTicket({ ticketId: "ticket-1" });
		if (!detail.ok) throw new Error(detail.error);
		expect(detail.value.ticket.notes.map((note) => note.text)).toEqual(["the host's own note"]);

		// And it recovers the assignment the previous host left running.
		await client.idle();
		const recovered = await client.openTicket({ ticketId: "ticket-1" });
		if (!recovered.ok) throw new Error(recovered.error);
		expect(recovered.value.ticket.assignmentIds).toHaveLength(2);
		expect(recovered.value.assignment?.state).toBe("pending");
		expect(recovered.value.ticket.inputs.some((input) => input.kind === "recovery")).toBe(true);
	});
});

describe("settings", () => {
	it("refuses to start on a settings document it cannot use", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, policy: { acceptMode: "sometimes" } }));
		const runtime = new Runtime({ stateDir: dir, source: new FakeSource(), executor: new FakeExecutor(), now: () => NOW });
		running.push(runtime);
		const started = await runtime.start();
		expect(started.ok).toBe(false);
		if (started.ok) throw new Error("expected a failure");
		expect(started.problems?.[0]?.path).toBe("policy.acceptMode");
		expect(started.error).toContain("settings are invalid");
	});

	it("saves a policy the surface edits and tells the engine what it bears on", async () => {
		const h = await host();
		const before = h.runtime.policy().version;
		const saved = await h.runtime.applyPolicy({ acceptMode: "inferred", rules: [{ id: "flaky", text: "Repair flaky tests", scope: "tests" }] });
		if (!saved.ok) throw new Error(saved.error);
		expect(saved.value.version).toBe(before + 1);
		expect(saved.value.acceptMode).toBe("inferred");
		expect(JSON.parse(readFileSync(join(h.dir, "settings.json"), "utf8")).policy.version).toBe(before + 1);

		const refused = await h.runtime.applyPolicy({ acceptMode: "sometimes" });
		expect(refused).toMatchObject({ ok: false });
		if (refused.ok) throw new Error("expected a failure");
		expect(refused.problems?.[0]?.path).toBe("policy.acceptMode");
	});
});

describe("wire", () => {
	it("carries one message per line and keeps an unfinished line for the next read", () => {
		const line = wireEncode({ kind: "request", id: "a", command: "rows" });
		const chunk = wireDecode(line + line.slice(0, 7));
		expect(chunk.messages).toEqual([{ kind: "request", id: "a", command: "rows" }]);
		expect(chunk.rest).toBe(line.slice(0, 7));

		const reply = wireEncode({ kind: "reply", id: "a", result: { ok: false, error: "no ticket", code: "unknownTicket" } });
		// The unfinished tail is completed by the rest of its line, then the next message follows.
		const completed = wireDecode(chunk.rest + line.slice(7) + reply);
		expect(completed.messages).toHaveLength(2);
		expect(completed.messages[1]).toEqual({
			kind: "reply",
			id: "a",
			result: { ok: false, error: "no ticket", code: "unknownTicket" },
		});
		expect(wireDecode("not json\n").messages).toEqual([]);
	});
});
