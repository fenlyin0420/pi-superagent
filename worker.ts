/**
 * The worker session's tools (docs/000-design.md "Worker protocol").
 *
 * A worker turn loads this extension with `-e`. Every tool appends one JSON line
 * to the Ticket's inbox file and answers with a short confirmation; the host
 * reads the file as it lands. A report therefore survives the turn dying, and
 * nothing here keeps state between turns.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The tools a worker runs with: the built-in work tools plus this extension's. */
const WORKER_TOOLS: readonly string[] = [
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
	"bash",
	"sagent_report",
	"sagent_ask",
	"sagent_note",
	"sagent_follow",
	"sagent_handback",
	"sagent_unrelated",
	"sagent_status",
];

const KINDS = ["progress", "waiting", "ready", "blocked", "failed", "dropped"] as const;

export default function worker(pi: ExtensionAPI): void {
	const workerPrompt = readWorkerPrompt();

	pi.on("session_start", async () => {
		pi.setActiveTools([...WORKER_TOOLS]);
	});

	// The worker's own instructions: what it owns, where its scope ends and how it reports.
	pi.on("before_agent_start", (event) => {
		if (workerPrompt === "") return undefined;
		return { systemPrompt: `${workerPrompt}\n\n${event.systemPrompt}` };
	});

	pi.registerTool({
		name: "sagent_report",
		label: "Report ticket status",
		description:
			"Report where this ticket stands to the host that runs it. progress keeps working, ready asks a person to review the result, blocked and failed say it cannot go on, dropped says there is nothing for a person to act on.",
		promptSnippet: "Report progress, a ready result, a blocker, a failure or a dropped ticket",
		promptGuidelines: [
			"Use sagent_report whenever the ticket's state changes for the host: progress while work continues, ready when a person should look at the result, blocked or failed when it cannot go on, dropped when there is nothing for a person to act on.",
			"Use sagent_report with question and options only when a person must decide something; sagent_ask writes the same waiting report and reads clearer for a question.",
		],
		parameters: Type.Object({
			kind: Type.Union(
				KINDS.map((kind) => Type.Literal(kind)),
				{ description: "The state the ticket is in now." },
			),
			text: Type.String({ description: "What the host should know: what is done, what is missing, what you need." }),
			question: Type.Optional(
				Type.String({ description: "One concrete question for a person, when the ticket waits for an answer." }),
			),
			options: Type.Optional(
				Type.Array(Type.String(), { description: "Answers a person may pick from, when the question offers a choice." }),
			),
		}),
		async execute(_toolCallId, params) {
			const question = params.question?.trim() ?? "";
			const options = params.options?.filter((option) => option.trim() !== "") ?? [];
			writeLine({
				tool: "report",
				kind: params.kind,
				text: params.text,
				...(question === "" ? {} : { question }),
				...(options.length === 0 ? {} : { options }),
			});
			return answered(`Reported ${params.kind} to the host.`, { kind: params.kind });
		},
	});

	pi.registerTool({
		name: "sagent_ask",
		label: "Ask a person",
		description:
			"Ask a person through the host. It writes a waiting report that carries the question, so the ticket stops taking automatic input until a person answers.",
		promptSnippet: "Ask a person a question and stop automatic work until it is answered",
		promptGuidelines: [
			"Use sagent_ask when only a person can decide: name the decision, say what you need, and offer options when there is a short list.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "One concrete question, with the options if the answer is a choice." }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Answers the person may pick from." })),
		}),
		async execute(_toolCallId, params) {
			const options = params.options?.filter((option) => option.trim() !== "") ?? [];
			writeLine({
				tool: "report",
				kind: "waiting",
				text: params.question,
				question: params.question,
				...(options.length === 0 ? {} : { options }),
			});
			return answered("Asked a person through the host; the ticket waits for the answer.", { question: params.question });
		},
	});

	pi.registerTool({
		name: "sagent_note",
		label: "Note for the ticket",
		description: "Record a short fact on this ticket for the host and for a person reading it later. It grants nothing and asks nothing.",
		promptSnippet: "Record a fact on this ticket for later reference",
		promptGuidelines: [
			"Use sagent_note for context a later turn needs, such as a command that reproduces the problem; keep it to one or two sentences.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "The fact to keep." }),
		}),
		async execute(_toolCallId, params) {
			writeLine({ tool: "note", text: params.text });
			return answered("Noted on the ticket.", {});
		},
	});

	pi.registerTool({
		name: "sagent_follow",
		label: "Follow a thread",
		description:
			"Follow another thread, such as an Issue or a pull request, for context only. Its messages reach this ticket but give it no authority and never resume it.",
		promptSnippet: "Follow another issue or pull request for context",
		promptGuidelines: [
			"Use sagent_follow when another thread helps this work, naming the thread key such as issue:42; it lends the ticket no authority.",
		],
		parameters: Type.Object({
			thread: Type.String({ description: "The thread key, such as issue:42 or pr:31." }),
		}),
		async execute(_toolCallId, params) {
			writeLine({ tool: "follow", thread: params.thread });
			return answered(`Following ${params.thread} for context.`, { thread: params.thread });
		},
	});

	pi.registerTool({
		name: "sagent_handback",
		label: "Hand a message back",
		description:
			"Hand a message back to the host because it asks for work beyond this ticket or for another ticket. The host assesses it again; this ticket hands each message back once.",
		promptSnippet: "Hand a message back as beyond this ticket",
		promptGuidelines: [
			"Use sagent_handback with the message's trigger id and one sentence of reason when a request is out of scope or belongs to another ticket; do not work on it afterwards.",
		],
		parameters: Type.Object({
			triggerId: Type.String({ description: "The trigger id of the message, as the turn input showed it." }),
			reason: Type.String({ description: "One sentence on what it asks for beyond this ticket." }),
		}),
		async execute(_toolCallId, params) {
			writeLine({ tool: "handback", triggerId: params.triggerId, reason: params.reason });
			return answered(`Handed ${params.triggerId} back to the host.`, { triggerId: params.triggerId });
		},
	});

	pi.registerTool({
		name: "sagent_unrelated",
		label: "Drop an unrelated thread",
		description:
			"Drop an attached thread that is not about this ticket, together with the messages there this ticket decides. The thread the ticket started on and its own pull request stay subscribed.",
		promptSnippet: "Drop an attached thread that is not about this ticket",
		promptGuidelines: [
			"Use sagent_unrelated with the thread key and one sentence of reason when a thread was routed here by mistake; the ticket's own threads stay subscribed.",
		],
		parameters: Type.Object({
			thread: Type.String({ description: "The thread key, such as issue:42." }),
			reason: Type.String({ description: "One sentence on why the thread is not about this ticket." }),
		}),
		async execute(_toolCallId, params) {
			writeLine({ tool: "unrelated", thread: params.thread, reason: params.reason });
			return answered(`Reported ${params.thread} as unrelated.`, { thread: params.thread });
		},
	});

	pi.registerTool({
		name: "sagent_status",
		label: "Record that the inputs are read",
		description:
			"Record that this turn has read the inputs the host delivered and is working. Call it once after reading the turn input, before the first external action.",
		promptSnippet: "Record that the delivered inputs are read",
		promptGuidelines: [
			"Use sagent_status once after reading the turn input, so the host knows the messages it delivered reached this session.",
		],
		parameters: Type.Object({}),
		async execute() {
			writeLine({ tool: "status" });
			return answered("Recorded that the inputs are read.", {});
		},
	});
}

// ------------------------------------------------------------------ inbox

/** `prompts/worker.md`, next to the built package or next to the source it is built from. */
function readWorkerPrompt(): string {
	for (const candidate of [
		new URL("../prompts/worker.md", import.meta.url),
		new URL("./prompts/worker.md", import.meta.url),
	]) {
		try {
			return readFileSync(candidate, "utf8").trim();
		} catch {
			continue;
		}
	}
	return "";
}

function writeLine(fields: Record<string, unknown>): void {
	const ticketId = required("SAGENT_TICKET");
	const stateDir = required("SAGENT_DIR");
	const file = join(stateDir, "inbox", `${ticketId}.jsonl`);
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ at: Date.now(), ticketId, ...fields })}\n`);
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (value === undefined || value === "") {
		throw new Error(
			`pi-superagent's worker tools need ${name}; this session was not started by the executor and has no ticket to report to.`,
		);
	}
	return value;
}

function answered(text: string, details: Record<string, unknown>): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	return { content: [{ type: "text", text }], details };
}
