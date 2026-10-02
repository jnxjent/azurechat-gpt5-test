import type { MemoryKind, MemoryMode, UserMemory } from "./memory-rules";
import { findNamedMemories, memoryKind, memoryKindLabel } from "./memory-rules";

export type MemoryChatCommand =
  | { kind: "list"; category?: MemoryKind | "lesson" }
  | { kind: "show"; query: string }
  | { kind: "rename"; query: string; title: string }
  | { kind: "delete"; query: string }
  | { kind: "learn"; feedback: string }
  | { kind: "save"; title: string; content: string; category: MemoryKind; mode: MemoryMode; triggers: string[] }
  | { kind: "needs_content" };

const artifact = "(?:メモ|md|スキル|skills?)";
const unquote = (text: string) => text.trim().replace(/^[「『"']|[」』"']$/g, "").trim();

export function parseMemoryChatCommand(message: string, previousAssistant?: string): MemoryChatCommand | undefined {
  const text = message.trim();
  const instructions = text.replace(/```[\s\S]*?```/g, "").replace(/[「『][^」』]*[」』]/g, "");
  const rename = text.match(new RegExp(`^(?:${artifact}\\s*)?[「『]([^」』]+)[」』](?:の(?:名前|保存名|名称))?を\\s*[「『]([^」』]+)[」』]に(?:変更|改名)(?:して)?[。!！]?$`, "i"))
    ?? text.match(new RegExp(`^(?:${artifact}\\s+)?(.+?)(?:の(?:名前|保存名|名称))?を\\s*(.+?)に(?:変更|改名)(?:して)?[。!！]?$`, "i"));
  if (rename && (new RegExp(artifact, "i").test(text) || /名前|保存名|名称/.test(text))) {
    return { kind: "rename", query: unquote(rename[1]), title: unquote(rename[2]) };
  }
  const deletion = text.match(new RegExp(`^(?:${artifact}\\s*)?[「『]([^」』]+)[」』](?:の${artifact})?を(?:削除|消去)(?:して)?[。!！]?$`, "i"))
    ?? text.match(new RegExp(`^${artifact}\\s*[「『]?(.+?)[」』]?を(?:削除|消去)(?:して)?[。!！]?$`, "i"))
    ?? text.match(new RegExp(`^(.+?)(?:の${artifact})を(?:削除|消去)(?:して)?[。!！]?$`, "i"));
  if (deletion) return { kind: "delete", query: unquote(deletion[1]) };
  const list = text.match(/^(?:私の|保存した)?(メモ|md|スキル|skills?|LearnedLesson|学習記録)(?:の)?一覧(?:を)?(?:見せて|表示して|教えて)?[。?？]?$/i);
  if (list) return { kind: "list", category: /learnedlesson|学習記録/i.test(list[1]) ? "lesson" : /skill|スキル/i.test(list[1]) ? "skill" : "memo" };
  if (/^(?:エラーでした|エラーです|失敗しました|失敗でした)(?:$|[。!！\s：:])/i.test(text) ||
    /(?:LearnedLesson|学習記録|反省)(?:として|に)(?:記録|保存|残)して/i.test(instructions)) {
    return { kind: "learn", feedback: text };
  }
  const save = /(?:覚えておいて|記憶して)/i.test(instructions) ||
    new RegExp(`${artifact}(?:として|に|を)?(?:保存|登録|残)して|${artifact}(?:に)?残して|${artifact}に入れて`, "i").test(instructions);
  if (!save) {
    if (new RegExp(`${artifact}.*(?:見せて|見たい|探して|確認して|表示して)`, "i").test(text) ||
      /(?:あの|例の|以前の).*(?:メモ|手順)/.test(text)) return { kind: "show", query: text };
    return undefined;
  }
  const category: MemoryKind = /スキル|\bskills?\b/i.test(instructions) ? "skill" : "memo";
  const named = text.match(/(?:名前|保存名|名称)(?:は|を|[:：])\s*「([^」]+)」/)?.[1]
    ?? text.match(/「([^」]+)」(?:という名前|の名前)(?:で|として)/)?.[1]
    ?? text.match(/(?:「[^」]+」|この内容|この回答|上記の?内容|先ほどの回答|今の説明|直前の回答)を\s*(「[^」]+」|[^、。\n]{1,120}?)として/)?.[1];
  const fenced = text.match(/```(?:md|markdown)?\s*\n([\s\S]+?)\n```/i)?.[1];
  const quoted = Array.from(text.matchAll(/「([^」]+)」/g)).map((match) => match[1]).find((value) => !named || value !== unquote(named));
  const afterColon = text.match(/(?:メモ|md|スキル|skills?|内容)\s*[:：]\s*([\s\S]+)/i)?.[1];
  const deictic = /(?:この|上記の?|先ほどの|今の|直前の)(?:内容|回答|手順|説明)/.test(instructions);
  const content = (fenced ?? afterColon ?? (deictic ? previousAssistant : quoted) ?? "").trim();
  if (!content) return { kind: "needs_content" };
  const title = named ? unquote(named) : content.split("\n")[0].replace(/^#+\s*/, "").slice(0, 50) || "メモ";
  return { kind: "save", title, content, category, mode: category === "memo" ? "always" : "manual", triggers: [] };
}

export function answerMemoryCommand(command: Extract<MemoryChatCommand, { kind: "list" | "show" | "needs_content" }>, memories: UserMemory[]): string {
  if (command.kind === "needs_content") return "保存する本文を「」で囲むか、直前の回答を「この内容」と指定してください。";
  if (command.kind === "list") {
    const items = memories.filter((item) => command.category === "lesson" ? !!item.learnedLesson : !command.category || memoryKind(item) === command.category);
    return items.length ? `保存済みの一覧:\n${items.map((item) => `- ${item.title} v${item.version}（${memoryKindLabel(item)}${item.enabled ? "" : "・無効"}）`).join("\n")}` : "該当する保存済みのメモ・スキルはありません。";
  }
  const matches = findNamedMemories(memories, command.query);
  if (matches.length === 0) return "該当するメモ・スキルが見つかりませんでした。";
  if (matches.length > 1) return ambiguousMemoryAnswer(matches);
  const item = matches[0];
  return `${memoryKindLabel(item)}「${item.title}」v${item.version}\n\n${item.content}`;
}

export function ambiguousMemoryAnswer(matches: UserMemory[]): string {
  return `複数のメモ・スキルが見つかりました。保存名を指定してください。\n${matches.map((item) => `- ${item.title}`).join("\n")}`;
}
