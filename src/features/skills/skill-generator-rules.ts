import { skillBytes, validateSkill } from "./skill-rules";
import type { SkillInput } from "./skill-rules";

export const GENERATOR_MAX_MESSAGES = 20;
export const GENERATOR_USER_MESSAGE_BYTES = 2000;
export const GENERATOR_ASSISTANT_MESSAGE_BYTES = 6000;
/** After this many user turns the assistant must stop asking and return a draft. */
export const GENERATOR_DRAFT_BY_TURN = 2;

export interface GeneratorMessage { role: "user" | "assistant"; content: string }
export interface GeneratorBase { scope: "own" | "shared"; ref: string; title: string; ownerName?: string; id?: string; version?: number; shared?: boolean }
export interface GeneratorInput { messages: GeneratorMessage[]; draft?: SkillInput; basedOn?: GeneratorBase; createNew?: boolean }
/** Keep the original revision and the user's publication choice throughout a conversation. */
export function retainGeneratorBase(current: GeneratorBase | null, incoming: GeneratorBase | undefined, publish: boolean, createNew: boolean) {
  if (createNew || current || !incoming) return { basedOn: current, publish };
  return { basedOn: incoming, publish: incoming.scope === "own" ? incoming.shared === true : publish };
}
/** A registered Skill offered to the model as a possible base. `ref` is opaque. */
export interface GeneratorCandidate { ref: string; scope: "own" | "shared"; title: string; description: string; content: string; ownerName?: string }

/** The first assistant message. Existing titles let the user reuse instead of duplicating. */
export function generatorOpening(existingTitles: string[], total: number): string {
  const examples = existingTitles.slice(0, 3).map(title => `「${title}」`).join("");
  return [
    "どんなスキルにするか教えてください。次の点を、わかる範囲で一度にお答えいただければ十分です。",
    "",
    "- 目的・成果物：何をさせたいですか（例：商談の週次サマリー、訪問後の報告書作成など）。",
    "- 使うデータ：Salesforce、社内資料、Webなど、参照したい情報源はありますか。",
    "- 出力形式：チャットでの回答、表、HTMLレポート（Web版でプレビュー・ダウンロード）など、希望はありますか。",
    "- 使う場面：誰が、どんなタイミングで使いますか（例：毎週月曜に営業所長が使う）。",
    "",
    "ざっくりした内容でも構いません。いただいた情報から最初のバージョンを作り、あとから調整できます。",
    ...(total > 0 ? ["", `なお、すでに${examples}${total > 3 ? "など" : ""}${total}件のスキルが登録されています（全社公開分を含む）。似たものがある場合は、そのスキルを改善する形にもできます。`] : []),
  ].join("\n");
}

export function validateGeneratorInput(value: unknown): GeneratorInput {
  if (!value || typeof value !== "object") throw new TypeError("作成するSkillの情報を入力してください。");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > GENERATOR_MAX_MESSAGES) {
    throw new TypeError("会話が長くなりすぎました。いったん保存するか、最初からやり直してください。");
  }
  const messages = input.messages.map((entry: unknown) => {
    const message = entry as Record<string, unknown> | null;
    const role = message?.role, content = typeof message?.content === "string" ? message.content.trim() : "";
    if ((role !== "user" && role !== "assistant") || !content) throw new TypeError("会話の形式が正しくありません。");
    if (skillBytes(content) > (role === "user" ? GENERATOR_USER_MESSAGE_BYTES : GENERATOR_ASSISTANT_MESSAGE_BYTES)) {
      throw new TypeError("1回の入力は2,000バイト以内にしてください。");
    }
    return { role, content } as GeneratorMessage;
  });
  if (messages[messages.length - 1].role !== "user") throw new TypeError("メッセージを入力してください。");
  const firstUser = messages.find(message => message.role === "user")!;
  if (/^(?:おまかせ|わからない|不明)$/.test(firstUser.content)) throw new TypeError("最初に、作りたいSkillの目的を教えてください。");
  let basedOn: GeneratorBase | undefined;
  if (input.basedOn !== undefined) {
    const base = input.basedOn as GeneratorBase;
    if (!base || (base.scope !== "own" && base.scope !== "shared") || typeof base.ref !== "string" ||
        (base.scope === "own" && (base.id !== base.ref || !/^skill-[a-f0-9]{64}$/.test(base.ref) || !Number.isSafeInteger(base.version) || base.version! < 1)) ||
        (base.scope === "shared" && !/^shared-[a-f0-9]{32}$/.test(base.ref))) throw new TypeError("更新元の情報が正しくありません。");
    basedOn = base;
  }
  return { messages, ...(input.draft === undefined ? {} : { draft: validateSkill(input.draft) }), ...(basedOn ? { basedOn } : {}), createNew: input.createNew === true };
}

const bigrams = (value: string) => {
  const text = value.normalize("NFKC").toLowerCase().replace(/[\s、。・,.!！?？「」『』（）()#*\-:：]/g, "");
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
};
/** Cheap lexical preselection; the model makes the final "is it the same job" judgement. */
export function similarCandidates(request: string, candidates: GeneratorCandidate[], limit = 3): GeneratorCandidate[] {
  const wanted = bigrams(request);
  if (!wanted.size) return [];
  return candidates.map(candidate => {
    const own = bigrams(`${candidate.title} ${candidate.description}`);
    let shared = 0;
    own.forEach(gram => { if (wanted.has(gram)) shared += 1; });
    return { candidate, score: own.size ? shared / own.size : 0 };
  }).filter(entry => entry.score >= 0.2).sort((a, b) => b.score - a.score).slice(0, limit).map(entry => entry.candidate);
}
