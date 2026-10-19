import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { sameSalesforceId, withSalesforceRecordId } from "./salesforce-search-query";
import { readFiscalPeriod } from "./skill-search-requirements";

export type SelectedSearchAccount = { id: string; name: string };

export function resolveSkillSearchPeriod(message: string, messages: Array<{role: string; content: unknown}>, now = Date.now()): { skillName: string; account: SelectedSearchAccount; originalRequest: string } | undefined {
  if (!readFiscalPeriod(message) || message.length > 300) return undefined;
  const lastAssistant = messages.find(item => item.role === "assistant");
  if (typeof lastAssistant?.content !== "string" || !/会計年度|会計期間|対象期間|売上|受注/.test(lastAssistant.content)) return undefined;
  // Only persisted server tool state from this user's own thread can resume a request.
  for (const item of messages) {
    if (item.role !== "tool" || typeof item.content !== "string") continue;
    try {
      const state = JSON.parse(item.content);
      if (!["skill_search_fiscal_pending", "skill_search_fiscal_complete"].includes(state.integration)) continue;
      const age = now - Date.parse(state.observedAt);
      if (!Number.isFinite(age) || age < 0 || age > 600_000 || typeof state.skillName !== "string" || /[「」『』\n]/.test(state.skillName) || !/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(state.account?.id) || typeof state.account.name !== "string" || typeof state.originalRequest !== "string") return undefined;
      if (!lastAssistant.content.includes(`参照したSkill: ${state.skillName} v`)) return undefined;
      return { skillName: state.skillName, account: state.account, originalRequest: state.originalRequest + "\n会計期間の回答: " + message };
    } catch { /* Unrelated persisted tool result. */ }
  }
  return undefined;
}

export function readSelectedAccountSnapshot(messages: Array<{role: string; content: unknown}>, accountId: string, now = Date.now()): Record<string, unknown> | undefined {
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try {
      const body = JSON.parse(message.content);
      const age = now - Date.parse(body.observedAt);
      if (body.integration !== "skill_search_account_candidates" || !Number.isFinite(age) || age < 0 || age > 600_000 || !Array.isArray(body.records)) continue;
      return body.records.map((item: Record<string, unknown>) => withSalesforceRecordId(item, "Account")).find((item: Record<string, unknown>) => sameSalesforceId(item.Id, accountId));
    } catch { /* Other tool messages are unrelated to account selection. */ }
  }
  return undefined;
}

export function isSkillSearchChoiceReply(message: string): boolean {
  return /^(?:\d{1,2}(?:番|番目)?(?:で|を)?(?:お願いします|選択します|にしてください|です)?[。.!！]?|[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)$/.test(normalizeChoiceReply(message));
}

function normalizeChoiceReply(message: string): string {
  return message.normalize("NFKC").trim().replace(/^(?:それでは|では|じゃあ)[、,\s]*/, "").trim();
}

// Carry a Skill only for a short choice reply to the immediately preceding
// account-selection question. Normal follow-up chats keep their original route.
export function resolveSkillSearchChoice(message: string, history: ChatCompletionMessageParam[]): { skillName: string; account: SelectedSearchAccount; originalRequest: string } | undefined {
  message = normalizeChoiceReply(message);
  const number = message.trim().match(/^(\d{1,2})(?:番|番目)?(?:で|を)?(?:お願いします|選択します|にしてください|です)?[。.!！]?$/)?.[1];
  const id = message.trim().match(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/)?.[0];
  if (!number && !id) return undefined;
  const last = history[history.length - 1];
  if (last?.role !== "assistant" || typeof last.content !== "string" || !/対象[^\n]*(?:選択|番号|指定)|候補[^\n]*(?:選択|確認)/.test(last.content)) return undefined;
  const skillName = last.content.match(/参照したSkill:\s*([^\n]+?)\s+v\d+\s*$/)?.[1];
  if (!skillName || /[「」『』\n]/.test(skillName)) return undefined;
  for (const line of last.content.split("\n")) {
    const match = line.match(/^\s*\|\s*(\d+)\s*\|\s*\[((?:\\.|[^\]])*)\]\(https:\/\/[^/]+\/lightning\/r\/Account\/([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)\/view\)/)
      ?? line.match(/^\s*(\d+)[.)、．]\s*(.*?)\s*—\s*\[[^\]]*\]\(https:\/\/[^/]+\/lightning\/r\/Account\/([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)\/view\)/);
    if (!match || (number ? match[1] !== number : match[3] !== id)) continue;
    const original = [...history].reverse().find(item => item.role === "user" && typeof item.content === "string" && item.content.includes(skillName));
    if (!original || typeof original.content !== "string") return undefined;
    return { skillName, account: { id: match[3], name: match[2].replace(/\*\*/g, "").replace(/\\([\\`*_[\]<>|])/g, "$1").trim() }, originalRequest: original.content };
  }
  return undefined;
}
