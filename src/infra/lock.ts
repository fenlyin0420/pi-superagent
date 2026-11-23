/**
 * The single-writer host lock (docs/000-design.md). A session is the host while it
 * owns `<state>/lock`; any other session is a client.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Ms } from "../core/model.js";

export interface LockHolder {
	pid: number;
	startedAt: Ms;
	sessionId: string;
}

export type Release = () => void;

const ATTEMPTS = 4;

export class HostLock {
	readonly file: string;
	private readonly clock: () => Ms;
	private readonly onExit: Release;
	private held = false;

	constructor(file: string, clock: () => Ms = Date.now) {
		this.file = file;
		this.clock = clock;
		this.onExit = () => this.release();
	}

	/**
	 * The holder, when its process is alive. A missing, corrupt or dead-holder
	 * file is no lock: those are the cases `acquire` takes over.
	 */
	probe(): LockHolder | null {
		const holder = this.read();
		return holder && alive(holder.pid) ? holder : null;
	}

	/**
	 * Take the lock when it is free or its holder is dead. Answers the release
	 * function, or `undefined` while another live process holds it.
	 */
	acquire(sessionId: string): Release | undefined {
		for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
			const holder: LockHolder = { pid: process.pid, startedAt: this.clock(), sessionId };
			try {
				writeFileSync(this.file, `${JSON.stringify(holder)}\n`, { flag: "wx" });
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") throw error;
				const current = this.read();
				if (current && alive(current.pid)) return undefined;
				// Stale: the holder is gone. Another process may clear it first.
				try {
					unlinkSync(this.file);
				} catch {
					/* Already cleared; the next attempt reports contention. */
				}
				continue;
			}
			this.held = true;
			process.on("exit", this.onExit);
			return this.onExit;
		}
		return undefined;
	}

	/** Drop the lock when this process holds it; harmless otherwise. */
	release(): void {
		if (!this.held) return;
		this.held = false;
		process.off("exit", this.onExit);
		const holder = this.read();
		if (!holder || holder.pid !== process.pid) return;
		try {
			unlinkSync(this.file);
		} catch {
			/* Another process already cleared the stale file. */
		}
	}

	private read(): LockHolder | null {
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch {
			return null;
		}
		return parse(raw);
	}
}

export function createLock(file: string, clock: () => Ms = Date.now): HostLock {
	return new HostLock(file, clock);
}

function parse(raw: string): LockHolder | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const holder = value as Record<string, unknown>;
	const { pid, startedAt, sessionId } = holder;
	if (typeof pid !== "number" || typeof startedAt !== "number" || typeof sessionId !== "string") return null;
	return { pid, startedAt, sessionId };
}

function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// A live process of another user answers EPERM, which is still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
