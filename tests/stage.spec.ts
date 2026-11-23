import { describe, expect, it } from "vitest";
import type { Stage, StageCode } from "../src/core/model.js";
import { stageLabel, ticketStage } from "../src/core/stage.js";
import { makeAssignment, makeInput, makeReport, makeTicket } from "../src/testing/fakes.js";

describe("ticketStage", () => {
	it("person / delivery: a failed Input delivery outranks every other row", () => {
		const ticket = makeTicket({
			delivery: { error: "session gone", at: 5 },
			attention: { question: "Which branch?", at: 6 },
			reports: [makeReport({ kind: "ready" })],
		});
		expect(ticketStage(ticket, makeAssignment(ticket))).toEqual({ kind: "person", code: "delivery" });
	});

	it("person / answer: an open Attention", () => {
		const ticket = makeTicket({
			attention: { question: "Which branch?", at: 6 },
			reports: [makeReport({ kind: "ready" })],
		});
		expect(ticketStage(ticket, makeAssignment(ticket))).toEqual({ kind: "person", code: "answer" });
	});

	it("person / review: the latest Report is ready", () => {
		const ticket = makeTicket({ reports: [makeReport({ kind: "ready" })] });
		expect(ticketStage(ticket, makeAssignment(ticket, { state: "ended" }))).toEqual({
			kind: "person",
			code: "review",
		});
	});

	it("person / blocked: a blocked Report with no person's message since", () => {
		const ticket = makeTicket({
			reports: [makeReport({ kind: "blocked", at: 100 })],
			inputs: [makeInput(makeTicket(), { kind: "trigger", at: 90 })],
		});
		expect(ticketStage(ticket, makeAssignment(ticket))).toEqual({ kind: "person", code: "blocked" });
	});

	it("person / failed: a failed Report with no person's message since", () => {
		const ticket = makeTicket({ reports: [makeReport({ kind: "failed", at: 100 })] });
		expect(ticketStage(ticket, makeAssignment(ticket, { state: "ended" }))).toEqual({
			kind: "person",
			code: "failed",
		});
	});

	it("releases a blocked ticket once a person's message arrived", () => {
		const base = makeTicket({ reports: [makeReport({ kind: "blocked", at: 100 })] });
		const running = makeAssignment(base, { state: "running" });
		const resumed = makeTicket({
			...base,
			inputs: [makeInput(base, { kind: "trigger", at: 101 })],
		});
		expect(ticketStage(resumed, running)).toEqual({ kind: "working", code: "working" });

		const pending = makeAssignment(base, { state: "pending" });
		expect(ticketStage(resumed, pending)).toEqual({ kind: "working", code: "queued" });
	});

	it("keeps the hold for a message that is not a person's", () => {
		for (const kind of ["policy", "recovery", "status", "note"] as const) {
			const base = makeTicket({ reports: [makeReport({ kind: "failed", at: 100 })] });
			const ticket = makeTicket({ ...base, inputs: [makeInput(base, { kind, at: 101 })] });
			expect(ticketStage(ticket, makeAssignment(base))).toEqual({ kind: "person", code: "failed" });
		}
	});

	it("a later report that is neither blocked nor failed lifts the hold", () => {
		const ticket = makeTicket({
			reports: [makeReport({ kind: "blocked", at: 100 }), makeReport({ kind: "progress", at: 110 })],
		});
		expect(ticketStage(ticket, makeAssignment(ticket))).toEqual({ kind: "working", code: "working" });
	});

	it("working / queued: no Assignment", () => {
		expect(ticketStage(makeTicket())).toEqual({ kind: "working", code: "queued" });
	});

	it("working / queued: a pending Assignment", () => {
		const ticket = makeTicket({ reports: [makeReport({ kind: "waiting", at: 100 })] });
		expect(ticketStage(ticket, makeAssignment(ticket, { state: "pending" }))).toEqual({
			kind: "working",
			code: "queued",
		});
	});

	it("idle: the latest Report is waiting", () => {
		const ticket = makeTicket({ reports: [makeReport({ kind: "waiting" })] });
		expect(ticketStage(ticket, makeAssignment(ticket))).toEqual({ kind: "idle", code: "idle" });
	});

	it("idle: the Assignment ended", () => {
		const ticket = makeTicket({ reports: [makeReport({ kind: "progress" })] });
		expect(ticketStage(ticket, makeAssignment(ticket, { state: "ended" }))).toEqual({
			kind: "idle",
			code: "idle",
		});
	});

	it("working: everything else", () => {
		const ticket = makeTicket({ reports: [makeReport({ kind: "progress" })] });
		expect(ticketStage(ticket, makeAssignment(ticket))).toEqual({ kind: "working", code: "working" });
		expect(ticketStage(makeTicket(), makeAssignment(makeTicket(), { state: "running" }))).toEqual({
			kind: "working",
			code: "working",
		});
	});
});

describe("stageLabel", () => {
	const codes: Array<{ code: StageCode; kind: Stage["kind"]; en: string; zh: string }> = [
		{ code: "delivery", kind: "person", en: "Input undelivered", zh: "输入未送达" },
		{ code: "answer", kind: "person", en: "Awaiting answer", zh: "待回答" },
		{ code: "review", kind: "person", en: "Awaiting review", zh: "待验收" },
		{ code: "blocked", kind: "person", en: "Blocked", zh: "待处理受阻" },
		{ code: "failed", kind: "person", en: "Failed", zh: "待处理失败" },
		{ code: "queued", kind: "working", en: "Queued", zh: "排队中" },
		{ code: "idle", kind: "idle", en: "Waiting for a Trigger", zh: "等待新触发" },
		{ code: "working", kind: "working", en: "Working", zh: "执行中" },
	];

	it("words every stage in both locales", () => {
		for (const { code, kind, en, zh } of codes) {
			const stage: Stage = { kind, code };
			expect(stageLabel(stage, "en")).toBe(en);
			expect(stageLabel(stage, "zh")).toBe(zh);
			expect(stageLabel(stage)).toBe(en);
		}
	});
});
