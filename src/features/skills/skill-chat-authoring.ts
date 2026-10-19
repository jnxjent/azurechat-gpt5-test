import { validateSkill } from "./skill-rules";
import type { SkillInput } from "./skill-rules";
type Message = { id?: string; role: string; content: unknown };
const plain = (text: string) => text.normalize("NFKC").replace(/[*#`]/g, "").trim();
const textOf = (message: Message) => typeof message.content === "string" ? message.content : "";
export const isSkillAuthoringRequest = (text: string) => {
  if (!/skills?|スキル/i.test(text) || !/作成|作って|作り|つく|生成|質問|generator/i.test(text)) return false;
  if (/使って|参照|従って|呼び出/.test(text) && !/(?:skills?|スキル)(?:を|の)?(?:作成|作り|作って|生成)|skillgenerator|スキルジェネレータ/i.test(text)) return false;
  return true;
};
function questionNumber(text: string): number | undefined {
  const value = plain(text).match(/(?:第\s*(\d+)\s*問|質問\s*(\d+)\s*[\/／])/);
  return value ? Number(value[1] ?? value[2]) : undefined;
}
function declaredTotal(text: string): number | undefined {
  const value = plain(text).match(/(?:全\s*(\d+)\s*問|(?:質問|進捗|第\s*\d+\s*問\s*[(（]?)\s*\d+\s*\/\s*(\d+)\s*(?:問|$|[)）\s]))/m);
  if (value) return Number(value[1] ?? value[2]);
  if (isSkillAuthoringRequest(text)) { const requested=plain(text).match(/(\d+)\s*問/); if(requested)return Number(requested[1]); }
  const number = questionNumber(text);
  return number && /(?:最終|最後)/.test(text) ? number : undefined;
}
export function skillAuthoringInstructions(message: string, history: readonly Message[]): string {
  const start = history.map(item => item.role === "user" && isSkillAuthoringRequest(textOf(item))).lastIndexOf(true);
  const fresh = isSkillAuthoringRequest(message);
  if (!fresh && start < 0) return "";
  const scope = fresh ? [] : history.slice(start);
  const lastAssistant = [...scope].reverse().find(item => item.role === "assistant");
  const previous = questionNumber(lastAssistant ? textOf(lastAssistant) : "");
  if (!fresh && !previous) return "";
  const explicit = plain(message).match(/(\d+)\s*問/)?.[1];
  const total = explicit ? Number(explicit) : scope.map(item => declaredTotal(textOf(item))).find(Boolean) ?? Math.max(5,(previous ?? 0)+1);
  const safeTotal = Math.min(20,Math.max(1,total));
  return `現在はSkillのプロンプトを利用者と作成しています。現在の依頼が別の話題ならそちらを優先してください。質問の総数は${safeTotal}問に固定し、最初に全${safeTotal}問と伝え、各質問の冒頭を必ず「質問 n/${safeTotal}」と表示してください。一度に一問だけ聞き、総数を予告なく増やさないでください。${previous && previous >= safeTotal ? "最終質問への回答を受けたので、追加質問せず完成したSkill本文を出力してください。" : "必要な項目に絞って質問してください。"}完成時はSkill名、目的、必須入力、実行手順、出力フォーマットの見出しで全文を出力してください。画面に保存ボタンが表示されるので、保存済みとは言わないでください。`;
}
export function extractChatSkillDraft(content: string): SkillInput | undefined {
  const lines = content.split(/\r?\n/).map(plain).filter(Boolean);
  const nameIndex = lines.findIndex(line => /^(?:Skill名|スキル名)(?:[:：].*)?$/i.test(line));
  const hasTitle = nameIndex >= 0 || /(?:skill|スキル)/i.test(lines[0] ?? "");
  const sections = [ /^(?:目的|Purpose)$/i, /^(?:実行手順|手順|進め方|Steps)$/i, /^(?:出力フォーマット|出力形式|Output)$/i ];
  if (!hasTitle || sections.filter(pattern => lines.some(line => pattern.test(line))).length < 2) return undefined;
  const title = nameIndex >= 0 ? lines[nameIndex].match(/[:：]\s*(.+)$/)?.[1] ?? lines[nameIndex + 1] : lines[0]?.replace(/(?:Skill|スキル)$/i, "").trim();
  try { return validateSkill({title,description:"チャットで作成したSkill",content}); } catch { return undefined; }
}
export function skillChatQuestionProgress(content: string, messages: readonly Message[], id?: string): string | undefined {
  const number = questionNumber(content); if (!number) return undefined;
  const index = id ? messages.findIndex(item => item.id === id) : messages.findIndex(item => textOf(item) === content);
  const upto = index >= 0 ? messages.slice(0,index+1) : messages;
  const start = upto.map(item => item.role === "user" && isSkillAuthoringRequest(textOf(item))).lastIndexOf(true);
  if (start < 0 && !/skills?|スキル/i.test(content)) return undefined;
  const after = index >= 0 ? messages.slice(index+1) : [];
  const nextStart = after.findIndex(item => item.role === "user" && isSkillAuthoringRequest(textOf(item)));
  const end = nextStart >= 0 ? index + 1 + nextStart : messages.length;
  const scope = messages.slice(Math.max(0,start),end);
  const total = declaredTotal(content) ?? scope.map(item => declaredTotal(textOf(item))).find(Boolean);
  return total && total >= number && total <= 20 ? `${number}/${total}` : undefined;
}
