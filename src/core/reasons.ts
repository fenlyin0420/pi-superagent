/**
 * Reason codes: why a Decision was made, why a Trigger was refused, why a Ticket
 * ended. Agents read the English sentence; the panel words the same code in the
 * reader's locale.
 *
 * `{name}` placeholders take their value from `Reason.values`.
 */
import type { Reason } from "./model.js";

export type Locale = "en" | "zh";

export interface ReasonText {
	en: string;
	zh: string;
}

export const REASONS = {
	timeout: {
		en: "Assessment timed out",
		zh: "评估超时",
	},
	policyChanged: {
		en: "Policy changed during the assessment",
		zh: "评估期间策略有变更",
	},
	routed: {
		en: "Routed to ticket {ticket}",
		zh: "已转给工单 {ticket}",
	},
	startedTicket: {
		en: "Already started ticket {ticket}",
		zh: "已经开始了工单 {ticket}",
	},
	not_allowed: {
		en: "The sender is not allowed to start work",
		zh: "该发送者不能发起工作",
	},
	not_a_member: {
		en: "The sender is not on the Source's allowed list",
		zh: "该发送者不在来源的允许名单中",
	},
	bot_actor: {
		en: "A bot cannot originate work",
		zh: "机器人不能发起工作",
	},
	source_disabled: {
		en: "The Source is off",
		zh: "来源已关闭",
	},
	already_working: {
		en: "A ticket is already working on this Thread",
		zh: "这个线程已有工单在处理",
	},
	stopped_by_person: {
		en: "A person stopped this ticket",
		zh: "有人已停止该工单",
	},
	duplicate: {
		en: "Duplicate of an earlier Trigger",
		zh: "与此前的触发重复",
	},
	ready_without_pull: {
		en: "Reported ready without a pull request",
		zh: "报告已完成，但没有 pull request",
	},
	nothing_to_do: {
		en: "Nothing to do for a person to act on",
		zh: "没有需要人处理的工作",
	},
	pull_merged: {
		en: "The pull request was merged",
		zh: "pull request 已合并",
	},
	pull_closed: {
		en: "The pull request was closed",
		zh: "pull request 已关闭",
	},
	resumed: {
		en: "Resumed by a person's message",
		zh: "因人的消息而继续",
	},
	handback: {
		en: "The Executor handed the message back for routing",
		zh: "执行器把消息交回路由",
	},
	unrelated: {
		en: "The Executor found this Thread unrelated to its ticket",
		zh: "执行器判定该线程与工单无关",
	},
	dismissed: {
		en: "A person dismissed this problem",
		zh: "有人已忽略该问题",
	},
	unavailable: {
		en: "The request could not be judged in time",
		zh: "未能及时判断该请求",
	},
	rule_changed: {
		en: "A matched rule changed: {rule}",
		zh: "匹配的规则有变更：{rule}",
	},
	requester_blocked: {
		en: "The requester may no longer start work",
		zh: "请求者已不能发起工作",
	},
	proactive_off: {
		en: "Proactive work is no longer accepted",
		zh: "不再接受主动接单",
	},
} as const satisfies Record<string, ReasonText>;

export type ReasonCode = keyof typeof REASONS;

/** The codes the engine uses, for validation and for the panel's code list. */
export const REASON_CODES = Object.keys(REASONS) as readonly ReasonCode[];

/**
 * One Reason, or a list of them joined with `; `, in the reader's locale. An
 * unknown code renders as itself, so a Source's or a gate's own code still reads.
 */
export function reasonText(reason: Reason | readonly Reason[] | undefined, locale: Locale = "en"): string {
	if (reason === undefined) return "";
	const list: readonly Reason[] = Array.isArray(reason) ? reason : [reason as Reason];
	return list.map((entry) => render(entry, locale)).join("; ");
}

export function isReasonCode(code: string): code is ReasonCode {
	return Object.hasOwn(REASONS, code);
}

function render(reason: Reason, locale: Locale): string {
	const template = isReasonCode(reason.code) ? REASONS[reason.code][locale] : reason.code;
	const text = template.replace(/\{(\w+)\}/g, (match, name: string) => reason.values?.[name] ?? match);
	return reason.triggerId ? `${reason.triggerId}: ${text}` : text;
}
