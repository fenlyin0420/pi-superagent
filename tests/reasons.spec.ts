import { describe, expect, it } from "vitest";
import { REASONS, REASON_CODES, isReasonCode, reasonText, type ReasonCode } from "../src/core/reasons.js";

const ENGINE_CODES: ReasonCode[] = [
	"timeout",
	"policyChanged",
	"routed",
	"startedTicket",
	"not_allowed",
	"not_a_member",
	"bot_actor",
	"source_disabled",
	"already_working",
	"stopped_by_person",
	"duplicate",
	"ready_without_pull",
	"nothing_to_do",
	"pull_merged",
	"pull_closed",
	"resumed",
	"handback",
	"unrelated",
	"dismissed",
	"unavailable",
	"rule_changed",
	"requester_blocked",
	"proactive_off",
];

describe("REASONS", () => {
	it("holds exactly the codes the engine uses", () => {
		expect([...REASON_CODES].sort()).toEqual([...ENGINE_CODES].sort());
	});

	it("renders every code in both locales", () => {
		for (const code of REASON_CODES) {
			const text = REASONS[code];
			expect(text.en.trim(), code).not.toBe("");
			expect(text.zh.trim(), code).not.toBe("");
			expect(text.zh, code).not.toBe(text.en);
		}
	});

	it("recognizes its own codes only", () => {
		expect(isReasonCode("timeout")).toBe(true);
		expect(isReasonCode("not_a_member")).toBe(true);
		expect(isReasonCode("said")).toBe(false);
		expect(isReasonCode("toString")).toBe(false);
	});
});

describe("reasonText", () => {
	it("render a code without values", () => {
		expect(reasonText({ code: "timeout" }, "en")).toBe("Assessment timed out");
		expect(reasonText({ code: "timeout" }, "zh")).toBe("评估超时");
		expect(reasonText({ code: "unavailable" })).toBe("The request could not be judged in time");
	});

	it("fills placeholders from the reason's values", () => {
		expect(reasonText({ code: "routed", values: { ticket: "tkt-12" } }, "en")).toBe("Routed to ticket tkt-12");
		expect(reasonText({ code: "routed", values: { ticket: "tkt-12" } }, "zh")).toBe("已转给工单 tkt-12");
		expect(reasonText({ code: "startedTicket", values: { ticket: "tkt-9" } }, "en")).toBe(
			"Already started ticket tkt-9",
		);
		expect(reasonText({ code: "rule_changed", values: { rule: "bump dependencies" } }, "en")).toBe(
			"A matched rule changed: bump dependencies",
		);
	});

	it("leaves a placeholder that has no value", () => {
		expect(reasonText({ code: "routed" }, "en")).toBe("Routed to ticket {ticket}");
	});

	it("prefixes a reason that belongs to one Trigger of a batch", () => {
		expect(reasonText({ code: "bot_actor", triggerId: "trg-3" }, "en")).toBe(
			"trg-3: A bot cannot originate work",
		);
	});

	it("renders a list in order, and nothing for no reason", () => {
		expect(
			reasonText(
				[
					{ code: "not_a_member" },
					{ code: "routed", values: { ticket: "tkt-1" } },
				],
				"en",
			),
		).toBe("The sender is not on the Source's allowed list; Routed to ticket tkt-1");
		expect(reasonText(undefined, "en")).toBe("");
		expect(reasonText([], "zh")).toBe("");
	});

	it("renders a code it does not know as itself, so a Source's own code still reads", () => {
		expect(reasonText({ code: "not_a_collaborator" }, "en")).toBe("not_a_collaborator");
		expect(reasonText({ code: "said", values: { text: "please stop" } }, "zh")).toBe("said");
	});
});
