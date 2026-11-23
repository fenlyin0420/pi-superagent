/**
 * The panel's keyboard map (docs/000-design.md "Panel"): which key means which
 * action, the hints under the list, and the line editor the answer needs.
 *
 * The matcher is injected so the panel uses Pi's keybinding manager instead of
 * hard-coding escape sequences, and so a test can press keys without a terminal.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import { t } from "../i18n.js";

export type PanelAction =
	| "up"
	| "down"
	| "open"
	| "answer"
	| "retry"
	| "stop"
	| "unsubscribe"
	| "pause"
	| "triggers"
	| "close"
	| "cancel";

/** The part of Pi's keybinding manager the panel uses. */
export interface KeyMatcher {
	matches(data: string, keybinding: string): boolean;
}

export function actionFor(data: string, keys: KeyMatcher): PanelAction | undefined {
	if (keys.matches(data, "tui.select.cancel")) return "cancel";
	if (keys.matches(data, "tui.select.up")) return "up";
	if (keys.matches(data, "tui.select.down")) return "down";
	if (keys.matches(data, "tui.select.confirm")) return "open";
	switch (data) {
		case "a":
			return "answer";
		case "r":
			return "retry";
		case "s":
			return "stop";
		case "u":
			return "unsubscribe";
		case "p":
			return "pause";
		case "t":
			return "triggers";
		case "q":
			return "close";
		default:
			return undefined;
	}
}

/** The hints the panel draws under the list; a narrow terminal gets the short set. */
export function keyHints(width: number): string {
	return width >= 80 ? t("panel.keys") : t("panel.keys.narrow");
}

export interface AnswerKey {
	text: string;
	submit: boolean;
	cancel: boolean;
}

/** One keystroke of the inline answer editor: text edits, `enter` submits, `escape` cancels. */
export function answerKey(data: string, text: string): AnswerKey {
	if (matchesKey(data, "enter")) return { text, submit: true, cancel: false };
	if (matchesKey(data, "escape")) return { text, submit: false, cancel: true };
	if (matchesKey(data, "backspace") || matchesKey(data, "delete")) return { text: dropLast(text), submit: false, cancel: false };
	const printable = printableCharacter(data);
	return printable === undefined ? { text, submit: false, cancel: false } : { text: `${text}${printable}`, submit: false, cancel: false };
}

/** The next selection index for a list of `length` items; a list of none answers 0. */
export function moved(index: number, length: number, action: PanelAction): number {
	if (length === 0) return 0;
	if (action === "up") return (index - 1 + length) % length;
	if (action === "down") return (index + 1) % length;
	return Math.min(Math.max(index, 0), length - 1);
}

/** Keep an index inside a list that may have shrunk under it. */
export function clamped(index: number, length: number): number {
	return length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1);
}

function dropLast(text: string): string {
	const characters = [...text];
	characters.pop();
	return characters.join("");
}

/** A single printable character; escape sequences and control keys answer undefined. */
function printableCharacter(data: string): string | undefined {
	const characters = [...data];
	const first = characters[0];
	if (characters.length !== 1 || first === undefined) return undefined;
	return first >= " " && first !== "\u007f" ? first : undefined;
}
