/**
 * The panel's contract with docs/000-design.md "Panel": every stage lands in its
 * section with the stage table's label, an empty state that is one line, a
 * terminal narrower than 60 columns that loses nothing it cannot show, and a
 * Chinese locale that words the whole surface.
 */
import { afterEach, describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Stage, StageCode, TicketRow } from "../src/core/model.js";
import { stageLabel } from "../src/core/stage.js";
import { getLocale, setLocale } from "../src/i18n.js";
import { PanelComponent, type PanelActions, type PanelStyle } from "../src/panel/app.js";
import { relativeTime, sectionsOf, type EndedRow, type PanelData } from "../src/panel/rows.js";

const NOW = Date.UTC(2025, 4, 1, 12, 0, 0);
const AGE = 2 * 60_000;

const STAGES: Record<StageCode, Stage> = {
	delivery: { kind: "person", code: "delivery" },
	answer: { kind: "person", code: "answer" },
	review: { kind: "person", code: "review" },
	blocked: { kind: "person", code: "blocked" },
	failed: { kind: "person", code: "failed" },
	queued: { kind: "working", code: "queued" },
	idle: { kind: "idle", code: "idle" },
	working: { kind: "working", code: "working" },
};

const plainStyle: PanelStyle = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function makeRow(index: number, stage: Stage): TicketRow {
	return {
		id: `ticket-${index}`,
		name: `work item ${index}`,
		stage,
		label: stageLabel(stage, "en"),
		source: "github",
		thread: `issue:${index}`,
		scope: "the request",
		reports: 1,
		pulls: ["#31"],
		updatedAt: NOW - AGE,
	};
}

function allRows(): TicketRow[] {
	return Object.values(STAGES).map((stage, index) => makeRow(index + 1, stage));
}

function data(rows: TicketRow[], ended: EndedRow[] = []): PanelData {
	return {
		repository: "owner/name",
		policyVersion: 3,
		host: { kind: "self" },
		paused: false,
		rows,
		ended,
	};
}

function actions(payload: PanelData): PanelActions {
	return {
		load: async () => payload,
		open: async (ticketId) => ({ ok: false, message: `open ${ticketId}` }),
		answer: async () => ({ ok: true }),
		retry: async () => ({ ok: true }),
		stop: async () => ({ ok: true }),
		unsubscribe: async () => ({ ok: true }),
		pause: async () => ({ ok: true }),
		resume: async () => ({ ok: true }),
		triggers: async () => ({ ok: true, triggers: [] }),
		done: () => undefined,
	};
}

function panel(payload: PanelData): PanelComponent {
	return new PanelComponent({
		actions: actions(payload),
		data: payload,
		keys: { matches: () => false },
		style: plainStyle,
		now: () => NOW,
	});
}

afterEach(() => {
	setLocale("en");
});

describe("panel sections", () => {
	it("puts every stage the table can answer in its section, under the table's label", () => {
		const rows = allRows();
		const sections = sectionsOf(rows, []);
		expect(sections.map((section) => section.id)).toEqual(["person", "working"]);

		const person = sections[0]?.rows ?? [];
		expect(person.map((row) => row.label)).toEqual(["delivery", "answer", "review", "blocked", "failed"].map((code) => stageLabel(STAGES[code as StageCode], "en")));
		expect(person.every((row) => row.glyph === "●")).toBe(true);

		const working = sections[1]?.rows ?? [];
		expect(working).toHaveLength(3);
		expect(working.map((row) => row.label)).toEqual([
			stageLabel(STAGES.queued, "en"),
			stageLabel(STAGES.idle, "en"),
			stageLabel(STAGES.working, "en"),
		]);
		expect(working.map((row) => row.glyph)).toEqual(["○", "○", "◐"]);
	});

	it("renders the ended section from ended rows and keeps them out of the open ones", () => {
		const ended: EndedRow[] = [
			{ id: "ticket-9", name: "add retry to uploader", label: "merged", pulls: ["#28"], endedAt: NOW - 3 * 3_600_000 },
		];
		const sections = sectionsOf([makeRow(1, STAGES.working)], ended);
		expect(sections.map((section) => section.id)).toEqual(["person", "working", "ended"]);
		const done = sections[2]?.rows ?? [];
		expect(done).toHaveLength(1);
		expect(done[0]?.glyph).toBe("✓");
		expect(done[0]?.label).toBe("merged");
	});

	it("words a relative time in the reader's locale", () => {
		expect(relativeTime(NOW - 20_000, NOW)).toBe("20s");
		expect(relativeTime(NOW - AGE, NOW)).toBe("2m");
		expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h");
		expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d");
		expect(relativeTime(NOW - 1_000, NOW)).toBe("now");
		setLocale("zh");
		expect(relativeTime(NOW - AGE, NOW)).toBe("2分");
	});
});

describe("panel rendering", () => {
	it("shows one line when no ticket exists", () => {
		const lines = panel(data([])).render(80);
		expect(lines).toContain("No tickets yet.");
		expect(lines.some((line) => line.includes("needs a person"))).toBe(false);
	});

	it("keeps every line inside a terminal narrower than 60 columns", () => {
		const component = panel(data(allRows()));
		for (const width of [40, 30, 20]) {
			const lines = component.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const narrow = component.render(40).join("\n");
		expect(narrow).not.toContain("pr#31");
		expect(narrow).not.toContain("2m");
		expect(narrow).toContain("work item 2");
	});

	it("words the header, the sections and the labels in Chinese", () => {
		setLocale("zh");
		expect(getLocale()).toBe("zh");
		const payload = data([makeRow(1, STAGES.answer), makeRow(2, STAGES.working)]);
		const text = panel(payload).render(80).join("\n");
		expect(text).toContain("仓库: owner/name");
		expect(text).toContain("待人工处理");
		expect(text).toContain("处理中");
		expect(text).toContain(stageLabel(STAGES.answer, "zh"));
		expect(text).not.toContain("needs a person");
		expect(text).not.toContain("awaiting");
	});

	it("marks the selected row and keeps the header wide enough for the policy version", () => {
		const lines = panel(data(allRows())).render(80);
		const selected = lines.filter((line) => line.startsWith("› "));
		expect(selected).toHaveLength(1);
		expect(lines[0]).toContain("policy v3");
		expect(lines[0]).toContain("host: this session");
	});
});
