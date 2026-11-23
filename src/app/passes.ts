/**
 * The 2 second pass (docs/000-design.md "Runtime", docs/007 in the reference).
 *
 * One pass kicks the due effects and then lets the Engine start and expire
 * Evals. Passes never overlap: a request that arrives while one runs schedules
 * exactly one more, so a Source or a panel action can ask for an immediate pass
 * without multiplying the work.
 */
import type { Engine } from "../core/ports.js";

export const PASS_INTERVAL_MS = 2_000;
export const PASS_JITTER_MS = 500;

export interface PassHost {
	engine: Pick<Engine, "evaluateDue">;
	effects: { kick(): void; idle(): Promise<void> };
	onError?: (error: unknown) => void;
	clock?: () => number;
	intervalMs?: number;
	jitterMs?: number;
	random?: () => number;
}

export class Passes {
	private readonly host: PassHost;
	private readonly intervalMs: number;
	private readonly jitterMs: number;
	private readonly random: () => number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private running: Promise<void> | undefined;
	private again: Promise<void> | undefined;

	constructor(host: PassHost) {
		this.host = host;
		this.intervalMs = host.intervalMs ?? PASS_INTERVAL_MS;
		this.jitterMs = host.jitterMs ?? PASS_JITTER_MS;
		this.random = host.random ?? Math.random;
	}

	start(): void {
		if (this.stopped || this.timer !== undefined) return;
		this.arm();
	}

	/** Stop the loop and wait for the pass in flight. */
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await Promise.allSettled([this.running, this.again]);
	}

	/** Stop the loop, then let the effect queue finish what it can. */
	async drain(): Promise<void> {
		await this.stop();
		await this.host.effects.idle();
	}

	/** Ask for a pass now, as a Source or a command does after it changed something. */
	request(): void {
		if (this.stopped) return;
		void this.pump().catch((error: unknown) => this.host.onError?.(error));
	}

	/** Run one pass, coalescing callers into at most one follow-up pass. */
	pump(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.running === undefined) {
			this.running = this.pass().finally(() => {
				this.running = undefined;
			});
			return this.running;
		}
		if (this.again === undefined) {
			const previous = this.running;
			const next = (): Promise<void> => {
				this.again = undefined;
				return this.pump();
			};
			this.again = previous.then(next, next);
		}
		return this.again;
	}

	private async pass(): Promise<void> {
		this.host.effects.kick();
		if (this.stopped) return;
		this.host.engine.evaluateDue();
	}

	private arm(): void {
		if (this.stopped) return;
		const delay = this.intervalMs + Math.floor(this.random() * this.jitterMs);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.request();
			this.arm();
		}, delay);
		this.timer.unref?.();
	}
}
