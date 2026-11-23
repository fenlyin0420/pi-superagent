/**
 * What the Executor and its workers report about the Assignments that run a
 * Ticket (docs/003-execution.md "Failure and recovery").
 *
 * Everything here is a fact the adapter observed; the Ticket's own state follows
 * from these facts and never from the Executor's session.
 */
import type { Assignment, Report, Ticket, TicketId } from "./model.js";
import type { EngineOptions } from "./part.js";
import { EnginePart, UserError, followsDone, liveTicket } from "./part.js";
import type { Tickets } from "./tickets.js";
import type { ReportInput } from "./ports.js";

const RECOVERY_NOTE =
	"The host restarted during this ticket. Inspect the working directory, git history and GitHub state before continuing. Do not repeat an external operation that already succeeded. Finish the original assignment and report its status.";

export class Assignments extends EnginePart {
	constructor(
		options: EngineOptions,
		private readonly tickets: Tickets,
	) {
		super(options);
	}

	/** 003: the Assignment runs; the launch already carries the Inputs that wait for it. */
	started(ticketId: TicketId, assignmentId: string): void {
		const ticket = this.require(ticketId);
		const assignment = this.requireAssignment(ticket, assignmentId);
		if (assignment.state === "ended") return;
		const at = this.now();
		assignment.state = "running";
		assignment.startedAt ??= at;
		// 003: preparation runs once, before the first launch, so a running launch found its directory.
		assignment.preparedAt ??= at;
		ticket.updatedAt = at;
		this.emit({ type: "assignment.started", at, ticketId, assignmentId });
	}

	/** 003: Inputs reached the worker; a failed delivery no longer shows on the Ticket. */
	delivered(ticketId: TicketId, assignmentId: string, inputIds: readonly string[]): void {
		const ticket = this.require(ticketId);
		const assignment = this.requireAssignment(ticket, assignmentId);
		if (assignment.state === "ended") return;
		const at = this.now();
		for (const input of ticket.inputs) {
			if (!inputIds.includes(input.id)) continue;
			input.deliveredAt = at;
			input.assignmentId = assignmentId;
		}
		delete ticket.delivery;
		ticket.updatedAt = at;
	}

	/** 003: the worker's session took the messages into a step, from which it has them. */
	read(ticketId: TicketId, inputIds: readonly string[]): void {
		const ticket = this.require(ticketId);
		const at = this.now();
		for (const input of ticket.inputs) {
			if (!inputIds.includes(input.id) || input.readAt !== undefined) continue;
			input.readAt = at;
		}
		ticket.updatedAt = at;
	}

	/** 003: a turn ended, so the worker is free for what waits. */
	turnEnded(ticketId: TicketId, assignmentId: string): void {
		const ticket = this.require(ticketId);
		const assignment = this.requireAssignment(ticket, assignmentId);
		if (assignment.state !== "running" || !liveTicket(ticket)) return;
		this.tickets.deliverPending(ticket);
	}

	/** 003: delivering Inputs failed; the Ticket shows it until a delivery succeeds or a new Assignment starts. */
	deliveryFailed(ticketId: TicketId, assignmentId: string, error: string): void {
		const ticket = this.require(ticketId);
		this.requireAssignment(ticket, assignmentId);
		ticket.delivery = { error: error.slice(0, 300), at: this.now() };
		ticket.updatedAt = this.now();
	}

	/**
	 * 003: an Assignment was running when the host stopped. One that reported since
	 * its last delivery keeps its session and takes what waits; one interrupted
	 * mid-turn starts again with a recovery note.
	 */
	interrupted(ticketId: TicketId, assignmentId: string): void {
		const ticket = this.require(ticketId);
		const assignment = this.requireAssignment(ticket, assignmentId);
		if (assignment.state === "ended" || !liveTicket(ticket)) return;
		const report = ticket.reports.filter((item) => item.assignmentId === assignmentId).at(-1);
		const settled =
			report !== undefined &&
			(report.kind === "waiting" || report.kind === "ready" || report.kind === "blocked" || report.kind === "failed");
		const busy = ticket.inputs.some((input) => input.assignmentId === assignmentId && input.deliveredAt !== undefined && (report === undefined || input.deliveredAt > report.at));
		if (settled && !busy) {
			this.tickets.deliverPending(ticket);
			return;
		}
		this.restart(ticket, assignment);
	}

	/** 003: a report with a question for a person, a ready result, or an end. */
	report(ticketId: TicketId, assignmentId: string, input: ReportInput): void {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		const assignment = this.requireAssignment(ticket, assignmentId);
		if (assignment.state === "ended") throw new UserError("assignmentEnded");
		if (input.kind === "ready" && input.attention !== undefined) throw new UserError("questionWithResult");
		const at = this.now();
		const report: Report = { at, kind: input.kind, text: input.text, assignmentId };
		if (input.attention !== undefined) {
			report.attention = { question: input.attention.question, options: input.attention.options, at, assignmentId };
		}
		ticket.reports.push(report);
		// 003: a question is asked, kept, or cleared by a ready result.
		if (input.kind === "ready") delete ticket.attention;
		else if (report.attention !== undefined) ticket.attention = report.attention;
		ticket.updatedAt = at;
		// 003: ordinary progress stays on its Ticket; a question for a person and every other report reach the router session.
		if (report.kind !== "progress") {
			this.effect({
				kind: "relay",
				message: {
					id: `report-${ticket.id}-${at}`,
					kind: report.attention === undefined ? "report" : "followup",
					at,
					ticketIds: [ticket.id],
					text: `Ticket ${ticket.id} (${ticket.name}) reported ${report.kind}: ${report.text}`,
				},
			});
		}
		const outcome = this.outcomeOf(ticket, input.kind);
		if (outcome !== undefined) this.tickets.end(ticket, "executor", outcome, at);
		else if (input.kind !== "blocked" && input.kind !== "failed") this.tickets.deliverPending(ticket);
	}

	// ------------------------------------------------------------- internals

	/** 003: `dropped` and `ready` end the Ticket; a ready one waits for the Threads it follows. */
	private outcomeOf(ticket: Ticket, kind: ReportInput["kind"]): "completed" | "merged" | "closed" | "dropped" | undefined {
		const followed = followsDone(ticket);
		if (kind === "dropped") return followed?.outcome ?? "dropped";
		if (kind !== "ready") return undefined;
		if (ticket.follows.length === 0) return "completed";
		return followed?.outcome;
	}

	private restart(ticket: Ticket, assignment: Assignment): void {
		this.tickets.restart(ticket, assignment, "hostRestarted", RECOVERY_NOTE);
	}
}
