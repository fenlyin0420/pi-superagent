/**
 * The Outbox: every message a Ticket writes to a Source's Channel goes out
 * through here (docs/000-design.md "Effects").
 *
 * A reply is an effect the effects queue retries, so the Outbox keeps one receipt
 * per stable message id: sending the same message again posts nothing. A message
 * whose conversation the Source no longer listens to is dropped rather than
 * retried forever; a failure is rethrown so the effect tries again, and the
 * Source's own marker makes that retry safe.
 *
 * Bodies are Markdown and are sent as written; only surrounding whitespace is
 * trimmed.
 */
import type { Ms, SourceId } from "../core/model.js";
import type { OutboundMessage } from "../core/ports.js";

export interface Receipt {
	/** The message's stable id, the key a retried effect repeats. */
	id: string;
	sentAt: Ms;
	/** The Source's own id for what it created, such as a GitHub comment id. */
	externalId?: string;
}

/** The write side of one Source, as the Outbox needs it (`GithubSource` is one). */
export interface ReplyChannel {
	readonly id: SourceId;
	/** Whether the conversation can still be written to; a message to one that cannot is dropped. */
	listens(conversation: string): boolean;
	/** Posts the Markdown body and answers the Source's id for it, when it reports one. */
	post(message: OutboundMessage): Promise<string | undefined>;
}

export interface OutboxOptions {
	/** The channel of a Source, or undefined while that Source is not running. */
	channel(source: SourceId): ReplyChannel | undefined;
	now?: () => Ms;
	/** A message that cannot be sent at all is reported here. */
	problem?(code: string, message: string): void;
}

export type SendResult = "sent" | "dropped";

export class Outbox {
	private readonly options: OutboxOptions;
	private readonly clock: () => Ms;
	/** One entry per message id: its send, in flight or settled. */
	private readonly sends = new Map<string, Promise<SendResult>>();
	private readonly sent = new Map<string, Receipt>();

	constructor(options: OutboxOptions) {
		this.options = options;
		this.clock = options.now ?? Date.now;
	}

	/**
	 * Delivers one message once. A repeat of a settled id answers what the first
	 * send did; a send that failed is forgotten, so the effect's retry goes out.
	 */
	async send(message: OutboundMessage): Promise<SendResult> {
		const known = this.sends.get(message.id);
		if (known !== undefined) return known;
		const send = this.deliver(message);
		this.sends.set(message.id, send);
		try {
			return await send;
		} catch (error) {
			this.sends.delete(message.id);
			throw error;
		}
	}

	/** What a message that went out left behind. */
	receipt(id: string): Receipt | undefined {
		return this.sent.get(id);
	}

	receipts(): Receipt[] {
		return [...this.sent.values()];
	}

	private async deliver(message: OutboundMessage): Promise<SendResult> {
		const body = message.body.trim();
		if (body === "") {
			this.options.problem?.("empty_reply", `Message ${message.id} has no body`);
			return "dropped";
		}
		// A Source that is not running yet is not gone: the effect retries this message later.
		const channel = this.options.channel(message.source);
		if (channel === undefined) throw new Error(`No channel is installed for ${message.source}`);
		if (!channel.listens(message.channel.conversation)) return "dropped";
		const externalId = await channel.post({ ...message, body });
		const sentAt = this.clock();
		this.sent.set(message.id, externalId === undefined ? { id: message.id, sentAt } : { id: message.id, sentAt, externalId });
		return "sent";
	}
}
