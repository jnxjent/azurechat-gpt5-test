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
  const list = text.match(/^(?:私の|保存した)?(メモ|md|スキル|skills?|LearnedLesson|学習記録)(?:の)?一覧(?:を)?(?:見せて|見たい|みたい|表示して|教えて|出して)?[。?？]?$/i);
  if (list) return { kind: "list", category: /learnedlesson|学習記録/i.test(list[1]) ? "lesson" : "memo" };
  if (/^(?:エラーでした|エラーです|失敗しました|失敗でした)(?:$|[。!！\s：:])/i.test(text) ||
    /(?:LearnedLesson|学習記録|反省)(?:として|に)(?:記録|保存|残)して/i.test(instructions)) {
    return { kind: "learn", feedback: text };
  }
  const namedSave = /(?:以下の?|下記の?|この|上記の?|先ほどの|今の|直前の)(?:内容|文章|手順)?を[、,\s]*「[^」]+」として(?:(?:メモ|md)に?)?(?:保存|保管|登録|記録)(?:して)?/i.test(text);
  const profileSave = /(?:以下|下記|次の内容|この内容)を[、,\s]*(?:私|わたし|利用者|ユーザー)?(?:の)?プロフィール(?:情報)?として[、,\s]*(?:メモ(?:しておいて|して|に保存して)|覚えておいて|保存して|記録して)/i.test(text);
  const save = /(?:覚えておいて|記憶して|メモしておいて)/i.test(instructions) || namedSave || profileSave ||
    new RegExp(`${artifact}(?:として|で|に|を)?(?:保存|保管|登録|記録|残)して|${artifact}(?:に)?残して|${artifact}に入れて`, "i").test(instructions);
  if (!save) {
    if (new RegExp(`${artifact}.*(?:見せて|見たい|探して|確認して|表示して)`, "i").test(text) ||
      /(?:あの|例の|以前の).*(?:メモ|手順)/.test(text)) return { kind: "show", query: text };
    return undefined;
  }
  const category: MemoryKind = "memo";
  const named = text.match(/(?:名前|保存名|名称)(?:は|を|[:：])\s*「([^」]+)」/)?.[1]
    ?? text.match(/「([^」]+)」(?:という名前|の名前)(?:で|として)/)?.[1]
    ?? text.match(/(?:「[^」]+」|この内容|この回答|以下の?内容|下記の?内容|上記の?内容|先ほどの回答|今の説明|直前の回答)を[、,\s]*(「[^」]+」|[^、。\n]{1,120}?)として/)?.[1]
    ?? (profileSave ? "プロフィール" : undefined);
  const fenced = text.match(/```(?:md|markdown)?\s*\n([\s\S]+?)\n```/i)?.[1];
  const quoted = Array.from(text.matchAll(/「([^」]+)」/g)).map((match) => match[1]).find((value) => !named || value !== unquote(named));
  const afterColon = text.match(/(?:メモ|md|スキル|skills?|内容)\s*[:：]\s*([\s\S]+)/i)?.[1];
  const afterSaveInstruction = text.match(/^(?:以下の?|下記の?|この|上記の?)(?:内容|文章|手順)?を[、,\s]*(?:「[^」]+」|『[^』]+』)?(?:として)?(?:(?:メモ|md)(?:で|に)?)?(?:保存|保管|登録|記録)(?:して)?[。!！]?\s*\r?\n+([\s\S]+)$/i)?.[1];
  const afterProfileInstruction = text.match(/^(?:以下|下記|次の内容|この内容)を[、,\s]*(?:私|わたし|利用者|ユーザー)?(?:の)?プロフィール(?:情報)?として[、,\s]*(?:メモ(?:しておいて|して|に保存して)|覚えておいて|保存して|記録して)[。!！]?\s*\r?\n+([\s\S]+)$/i)?.[1];
  const prefixed = text.match(/^(?:以下|下記)を[、,\s]*([\s\S]+?)\s*(?:メモ|md)(?:で|に)?(?:保存|保管|登録|記録)(?:して)?[。!！]?$/i)?.[1];
  const deictic = /(?:この|以下の?|下記の?|上記の?|先ほどの|今の|直前の)(?:内容|回答|手順|説明)/.test(instructions);
  const content = (fenced ?? afterColon ?? afterSaveInstruction ?? afterProfileInstruction ?? prefixed ?? (deictic ? previousAssistant : quoted) ?? "").trim();
  if (!content) return { kind: "needs_content" };
  const title = named ? unquote(named) : content.split("\n")[0].replace(/^#+\s*/, "").slice(0, 50) || "メモ";
  const profile = /(?:プロフィール|ユーザー属性|利用者属性|自分の情報)/.test(`${title}\n${content}`);
  const always = /(?:毎回|常に|必ず)(?:参照|適用)/.test(instructions);
  return { kind: "save", title, content, category, mode: profile ? "required" : always ? "always" : "manual", triggers: [] };
}

export function answerMemoryCommand(command: Extract<MemoryChatCommand, { kind: "list" | "show" | "needs_content" }>, memories: UserMemory[]): string {
  if (command.kind === "needs_content") return "保存したい本文を、保存の指示の次の行にそのまま入力してください。直前の回答を保存する場合は、この内容をメモで保存して、と入力できます。";
  if (command.kind === "list") {
    const items = memories.filter((item) => command.category === "lesson" ? !!item.learnedLesson : true);
    return items.length ? `保存済みの一覧:\n${items.map((item) => `- ${item.title} v${item.version}（${memoryKindLabel(item)}${item.enabled ? "" : "・無効"}）`).join("\n")}` : "該当する保存済みのメモはありません。";
  }
  const matches = findNamedMemories(memories, command.query);
  if (matches.length === 0) return "該当するメモが見つかりませんでした。";
  if (matches.length > 1) return ambiguousMemoryAnswer(matches);
  const item = matches[0];
  return `${memoryKindLabel(item)}「${item.title}」v${item.version}\n\n${item.content}`;
}

export function ambiguousMemoryAnswer(matches: UserMemory[]): string {
  return `複数のメモが見つかりました。保存名を指定してください。\n${matches.map((item) => `- ${item.title}`).join("\n")}`;
}
