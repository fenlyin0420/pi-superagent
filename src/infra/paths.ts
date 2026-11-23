/**
 * Every path the state directory holds (docs/000-design.md). `PI_SUPERAGENT_DIR`
 * overrides the default root; an explicit root wins over both, which is how the
 * runtime applies `settings.stateDir` after it has read the settings file.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Paths {
	readonly root: string;
	readonly stateFile: string;
	readonly journalFile: string;
	readonly lockFile: string;
	readonly settingsFile: string;
	readonly effectsFile: string;
	readonly socketFile: string;
	/** One checkout per ticket, named after the ticket's short name. */
	readonly workDir: string;
	/** Worker Pi session files, one directory per session id. */
	readonly sessionsDir: string;
	/** Worker report files, one per ticket. */
	readonly inboxDir: string;
	ensureDirs(): void;
	ticketDir(name: string): string;
	sessionDir(ticketId: string): string;
	inboxFile(ticketId: string): string;
}

export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_SUPERAGENT_DIR?.trim();
	if (!override) return join(homedir(), ".pi", "superagent");
	// A shell-style leading `~` is expanded here; the variable is set by hand usually.
	const expanded =
		override === "~" || override.startsWith("~/") ? join(homedir(), override.slice(1)) : override;
	return resolve(expanded);
}

export function createPaths(root: string = defaultStateRoot()): Paths {
	const base = resolve(root);
	const workDir = join(base, "work");
	const sessionsDir = join(base, "sessions");
	const inboxDir = join(base, "inbox");
	return {
		root: base,
		stateFile: join(base, "state.json"),
		journalFile: join(base, "journal.jsonl"),
		lockFile: join(base, "lock"),
		settingsFile: join(base, "settings.json"),
		effectsFile: join(base, "effects.jsonl"),
		socketFile: join(base, "superagent.sock"),
		workDir,
		sessionsDir,
		inboxDir,
		ensureDirs(): void {
			for (const directory of [base, workDir, sessionsDir, inboxDir]) mkdirSync(directory, { recursive: true });
		},
		ticketDir(name: string): string {
			return join(workDir, name);
		},
		sessionDir(ticketId: string): string {
			return join(sessionsDir, ticketId);
		},
		inboxFile(ticketId: string): string {
			return join(inboxDir, `${ticketId}.jsonl`);
		},
	};
}
