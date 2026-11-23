import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Assignment, Input, Ticket, ThreadKey, TicketId, TriggerId } from "../src/core/model.js";
import type { EngineForExecutor, LaunchRequest, ReportInput, TurnResult } from "../src/core/ports.js";
import { piSessionId, PiExecutor, renderTurn } from "../src/executor/pi.js";
import { isTransientFailure, type TurnHandle, type TurnRequest } from "../src/executor/spawn.js";
import { createPaths, type Paths } from "../src/infra/paths.js";

// -------------------------------------------------------------------- engine

class RecordingEngine implements EngineForExecutor {
	readonly started: Array<{ ticketId: TicketId; assignmentId: string }> = [];
	readonly delivered: Array<{ ticketId: TicketId; assignmentId: string; inputIds: string[] }> = [];
	readonly read: Array<{ ticketId: TicketId; inputIds: string[] }> = [];
	readonly ended: Array<{ ticketId: TicketId; assignmentId: string }> = [];
	readonly failed: Array<{ ticketId: TicketId; assignmentId: string; error: string }> = [];
	readonly reports: Array<{ ticketId: TicketId; assignmentId: string; report: ReportInput }> = [];
	readonly followed: Array<{ ticketId: TicketId; thread: ThreadKey }> = [];
	readonly unrelated: Array<{ ticketId: TicketId; thread: ThreadKey; reason: string }> = [];
	readonly handbacks: Array<{ ticketId: TicketId; triggerId: TriggerId; reason: string }> = [];
	readonly interrupted: Array<{ ticketId: TicketId; assignmentId: string }> = [];

	assignmentStarted(ticketId: TicketId, assignmentId: string): void {
		this.started.push({ ticketId, assignmentId });
	}

	inputsDelivered(ticketId: TicketId, assignmentId: string, inputIds: string[]): void {
		this.delivered.push({ ticketId, assignmentId, inputIds });
	}

	inputsRead(ticketId: TicketId, inputIds: string[]): void {
		this.read.push({ ticketId, inputIds });
	}

	turnEnded(ticketId: TicketId, assignmentId: string): void {
		this.ended.push({ ticketId, assignmentId });
	}

	deliveryFailed(ticketId: TicketId, assignmentId: string, error: string): void {
		this.failed.push({ ticketId, assignmentId, error });
	}

	report(ticketId: TicketId, assignmentId: string, report: ReportInput): void {
		this.reports.push({ ticketId, assignmentId, report });
	}

	markUnrelated(ticketId: TicketId, thread: ThreadKey, reason: string): void {
		this.unrelated.push({ ticketId, thread, reason });
	}

	followForContext(ticketId: TicketId, thread: ThreadKey): void {
		this.followed.push({ ticketId, thread });
	}

	handback(ticketId: TicketId, triggerId: TriggerId, reason: string): boolean {
		this.handbacks.push({ ticketId, triggerId, reason });
		return true;
	}

	assignmentInterrupted(ticketId: TicketId, assignmentId: string): void {
		this.interrupted.push({ ticketId, assignmentId });
	}
}

// ------------------------------------------------------------------ fixtures

let root: string;
let paths: Paths;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sagent-executor-"));
	paths = createPaths(root);
	paths.ensureDirs();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.PI_SUPERAGENT_PI_BIN;
});

let counter = 0;

function makeTicket(name = "fix-upload"): Ticket {
	counter += 1;
	const ticket: Ticket = {
		id: `ticket-${counter}`,
		name,
		source: "github",
		thread: "issue:12",
		mandate: {
			policyVersion: 1,
			scope: "fix the flaky upload test",
			strength: "explicit",
			matchedRules: [],
			requester: { id: "alice", bot: false },
			receivedAs: "issue_comment",
			triggerId: `trg-${counter}`,
			triggerIds: [`trg-${counter}`],
		},
		origin: { triggerId: `trg-${counter}`, triggerIds: [`trg-${counter}`] },
		execution: { name, directory: paths.ticketDir(name) },
		follows: [],
		subscriptions: ["issue:12"],
		inputs: [],
		reports: [],
		assignmentIds: [],
		notes: [],
		createdAt: 1_000,
		updatedAt: 1_000,
	};
	mkdirSync(ticket.execution.directory, { recursive: true });
	return ticket;
}

function makeAssignment(ticket: Ticket, id = `asg-${ticket.id}`): Assignment {
	return {
		id,
		ticketId: ticket.id,
		state: "pending",
		sessionId: `sagent/${ticket.id}`,
		directory: ticket.execution.directory,
	};
}

function makeInput(ticket: Ticket, patch: Partial<Input> = {}): Input {
	counter += 1;
	const input: Input = {
		id: `in-${counter}`,
		ticketId: ticket.id,
		kind: "trigger",
		text: "Please fix the flaky upload test.",
		at: 2_000 + counter,
		...patch,
	};
	ticket.inputs.push(input);
	return input;
}

function request(ticket: Ticket, assignment: Assignment, brief = "Fix the flaky upload test."): LaunchRequest {
	return { ticket, assignment, brief };
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the executor");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function ticks(count = 5): Promise<void> {
	for (let index = 0; index < count; index += 1) await new Promise((resolve) => setTimeout(resolve, 15));
}

/** A turn the test starts and finishes itself, instead of a Pi process. */
class ManualTurns {
	readonly requests: TurnRequest[] = [];
	readonly open: Array<{ request: TurnRequest; finish: (result: TurnResult) => void }> = [];
	peak = 0;
	private active = 0;

	start = (turn: TurnRequest): TurnHandle => {
		this.requests.push(turn);
		this.active += 1;
		this.peak = Math.max(this.peak, this.active);
		let settle: (result: TurnResult) => void = () => {};
		const result = new Promise<TurnResult>((resolve) => {
			settle = resolve;
		});
		let done = false;
		const entry = {
			request: turn,
			finish: (value: TurnResult): void => {
				if (done) return;
				done = true;
				this.active -= 1;
				settle(value);
			},
		};
		this.open.push(entry);
		return {
			result,
			kill: async (reason?: string): Promise<void> => {
				entry.finish({ ok: false, exitCode: null, lastWords: "", transient: false, error: reason });
			},
		};
	};

	finish(index: number, result: Partial<TurnResult> = {}): void {
		const entry = this.open[index];
		if (entry === undefined) throw new Error(`no open turn at ${index}`);
		entry.finish({ ok: true, exitCode: 0, lastWords: "done", transient: false, ...result });
	}
}

// ----------------------------------------------------------------- transient

describe("isTransientFailure", () => {
	it("passes 408, 429 and 5xx through as retryable", () => {
		expect(isTransientFailure("Error: 408 Request Timeout")).toBe(true);
		expect(isTransientFailure("openai 429 rate limit reached")).toBe(true);
		expect(isTransientFailure("upstream answered 503 Service Unavailable")).toBe(true);
	});

	it("passes a broken connection through as retryable", () => {
		expect(isTransientFailure("read ECONNRESET")).toBe(true);
		expect(isTransientFailure("connect ETIMEDOUT 10.0.0.1:443")).toBe(true);
		expect(isTransientFailure("connect ECONNREFUSED 127.0.0.1:8080")).toBe(true);
	});

	it("leaves a real failure alone", () => {
		expect(isTransientFailure("fatal: not a git repository")).toBe(false);
		expect(isTransientFailure("error TS2339: Property 'x' does not exist")).toBe(false);
		expect(isTransientFailure("")).toBe(false);
	});
});

// ---------------------------------------------------------------- rendering

describe("renderTurn", () => {
	it("carries the assignment brief and every input", () => {
		const ticket = makeTicket("fix-upload");
		const trigger = makeInput(ticket, { kind: "trigger", triggerId: "trg-1", text: "The upload test is flaky on CI." });
		const note = makeInput(ticket, { kind: "note", text: "The router saw the same failure in #9." });

		const text = renderTurn(ticket, { assignment: "Fix the flaky upload test, then open a PR.", inputs: [trigger, note] });

		expect(text).toContain(`# Ticket fix-upload (${ticket.id})`);
		expect(text).toContain(`Directory: ${ticket.execution.directory}`);
		expect(text).toContain("## Assignment");
		expect(text).toContain("Fix the flaky upload test, then open a PR.");
		expect(text).toContain("## Inputs");
		expect(text).toContain("The upload test is flaky on CI.");
		expect(text).toContain("The router saw the same failure in #9.");
		expect(text).toContain("### 1. trigger · trg-1");
		expect(text).toContain("### 2. note");
	});

	it("leaves out a section it has nothing for", () => {
		const ticket = makeTicket("fix-upload");
		const text = renderTurn(ticket, { request: "Report the current ticket status." });
		expect(text).toContain("## Request");
		expect(text).not.toContain("## Assignment");
		expect(text).not.toContain("## Inputs");
	});
});

describe("piSessionId", () => {
	it("turns the engine's session name into one Pi accepts", () => {
		expect(piSessionId("sagent/ticket-3")).toBe("sagent-ticket-3");
		expect(piSessionId("sagent/ticket-3")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/);
	});
});

// ------------------------------------------------------------------ slots

describe("worker slots", () => {
	it("leaves the assignment pending through prepare and reports it started with the launch", async () => {
		const engine = new RecordingEngine();
		const turns = new ManualTurns();
		const executor = new PiExecutor({
			engine,
			paths,
			settings: () => ({ prepare: "true", maxWorkers: 1 }),
			startTurn: turns.start,
			pollMs: 10,
			transientBackoffMs: [],
		});

		const ticket = makeTicket("first");
		const assignment = makeAssignment(ticket, "asg-first");

		// Prepare only makes the directory: the queued launch is the row that starts the turn.
		executor.prepare(request(ticket, assignment));
		await waitFor(() => existsSync(ticket.execution.directory));
		await ticks();
		expect(engine.started).toHaveLength(0);

		executor.launch(request(ticket, assignment));
		await waitFor(() => turns.requests.length === 1);
		expect(engine.started).toEqual([{ ticketId: ticket.id, assignmentId: assignment.id }]);

		turns.finish(0);
		await executor.shutdown();
	});

	it("keeps one turn running while a person's message takes the extra slot", async () => {
		const engine = new RecordingEngine();
		const turns = new ManualTurns();
		const executor = new PiExecutor({
			engine,
			paths,
			settings: () => ({ prepare: "true", maxWorkers: 1 }),
			startTurn: turns.start,
			pollMs: 10,
			transientBackoffMs: [],
		});

		const first = makeTicket("first");
		const second = makeTicket("second");
		const third = makeTicket("third");
		const firstAssignment = makeAssignment(first, "asg-first");
		const secondAssignment = makeAssignment(second, "asg-second");
		const thirdAssignment = makeAssignment(third, "asg-third");

		executor.launch(request(first, firstAssignment));
		await waitFor(() => turns.requests.length === 1);

		// A person's message wakes the second ticket in the slot kept for it.
		executor.deliver(second, secondAssignment, [makeInput(second, { kind: "resume", text: "Any update?" })]);
		await waitFor(() => turns.requests.length === 2);
		expect(turns.peak).toBe(2);

		// A CI result on the third ticket is ordinary work: it waits for a normal slot.
		executor.deliver(third, thirdAssignment, [makeInput(third, { kind: "trigger", text: "CI is red on main." })]);
		await ticks();
		expect(turns.requests.length).toBe(2);

		// The extra slot goes back with the second turn; the first still holds the only normal slot.
		turns.finish(1);
		await ticks();
		expect(turns.requests.length).toBe(2);

		turns.finish(0);
		await waitFor(() => turns.requests.length === 3);
		expect(turns.requests[2]?.input).toContain("CI is red on main.");
		expect(turns.peak).toBe(2);

		await executor.shutdown();
	});

	it("reports the inputs it rendered and the turn's end", async () => {
		const engine = new RecordingEngine();
		const turns = new ManualTurns();
		const executor = new PiExecutor({
			engine,
			paths,
			settings: () => ({ prepare: "true", maxWorkers: 2 }),
			startTurn: turns.start,
			pollMs: 10,
			transientBackoffMs: [],
		});

		const ticket = makeTicket("first");
		const trigger = makeInput(ticket, { triggerId: "trg-1" });
		const assignment = makeAssignment(ticket, "asg-first");

		executor.prepare(request(ticket, assignment));
		executor.launch(request(ticket, assignment));
		await waitFor(() => turns.requests.length === 1);

		expect(turns.requests[0]?.input).toContain("Please fix the flaky upload test.");
		expect(turns.requests[0]?.input).toContain("Fix the flaky upload test.");
		expect(turns.requests[0]?.sessionId).toBe(piSessionId(assignment.sessionId));
		expect(turns.requests[0]?.env.SAGENT_TICKET).toBe(ticket.id);
		expect(turns.requests[0]?.env.SAGENT_DIR).toBe(root);
		expect(engine.started).toHaveLength(1);
		expect(engine.delivered).toEqual([{ ticketId: ticket.id, assignmentId: assignment.id, inputIds: [trigger.id] }]);

		turns.finish(0);
		await waitFor(() => engine.ended.length === 1);
		expect(engine.read).toEqual([{ ticketId: ticket.id, inputIds: [trigger.id] }]);
		expect(engine.failed).toHaveLength(0);

		await executor.shutdown();
	});
});

// ------------------------------------------------------------------ report

describe("report ingestion", () => {
	it("reads a turn's report from the ticket's inbox file", async () => {
		const engine = new RecordingEngine();
		const inbox = paths.inboxFile("ticket-report");
		const argsFile = join(root, "turn.json");
		const binary = join(root, "fake-pi.mjs");
		writeFileSync(
			binary,
			`#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
writeFileSync(process.env.SAGENT_TEST_ARGS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
mkdirSync(dirname(process.env.SAGENT_TEST_INBOX), { recursive: true });
appendFileSync(process.env.SAGENT_TEST_INBOX, JSON.stringify({
	at: Date.now(),
	ticketId: process.env.SAGENT_TICKET,
	tool: "report",
	kind: "ready",
	text: "Fixed the flaky upload test and opened PR #7.",
}) + "\\n");
appendFileSync(process.env.SAGENT_TEST_INBOX, JSON.stringify({
	at: Date.now(),
	ticketId: process.env.SAGENT_TICKET,
	tool: "note",
	text: "The test was waiting on an unclosed stream.",
}) + "\\n");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Opened PR #7." }] } }));
`,
			{ mode: 0o755 },
		);
		chmodSync(binary, 0o755);
		process.env.PI_SUPERAGENT_PI_BIN = binary;

		const executor = new PiExecutor({
			engine,
			paths,
			settings: () => ({ prepare: "true", maxWorkers: 1 }),
			environment: () => ({ SAGENT_TEST_INBOX: inbox, SAGENT_TEST_ARGS: argsFile }),
			pollMs: 20,
			transientBackoffMs: [],
			turnTimeoutMs: 20_000,
		});

		const ticket = makeTicket("report");
		ticket.id = "ticket-report";
		const trigger = makeInput(ticket, { triggerId: "trg-1" });
		const assignment = makeAssignment(ticket, "asg-report");

		try {
			executor.prepare(request(ticket, assignment));
			executor.launch(request(ticket, assignment));

			await waitFor(() => engine.reports.length >= 2);
			await waitFor(() => engine.ended.length === 1);

			expect(engine.reports[0]?.report).toEqual({ kind: "ready", text: "Fixed the flaky upload test and opened PR #7." });
			// A note reaches the ticket as progress, which asks a person for nothing.
			expect(engine.reports[1]?.report).toEqual({ kind: "progress", text: "The test was waiting on an unclosed stream." });
			expect(engine.delivered[0]?.inputIds).toEqual([trigger.id]);
			expect(engine.read[0]?.inputIds).toEqual([trigger.id]);
			expect(engine.ended).toEqual([{ ticketId: ticket.id, assignmentId: assignment.id }]);

			expect(existsSync(argsFile)).toBe(true);
			const turn = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[]; cwd: string };
			expect(turn.args.slice(0, 8)).toEqual([
				"--session-id",
				piSessionId(assignment.sessionId),
				"--session-dir",
				paths.sessionDir(ticket.id),
				"--mode",
				"json",
				"-p",
				expect.stringContaining("Fix the flaky upload test."),
			]);
			expect(turn.args.at(-1)).toMatch(/worker\.js$/);
			expect(turn.cwd).toBe(ticket.execution.directory);
		} finally {
			await executor.shutdown();
		}
	});
});
