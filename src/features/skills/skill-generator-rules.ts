import { skillBytes, validateSkill } from "./skill-rules";
import type { SkillInput } from "./skill-rules";

export const GENERATOR_QUESTIONS = [
  { title: "どんな仕事をするSkillを作りますか？", hint: "例：訪問前に顧客情報・商談・ニュースを整理したい", examples: ["お客様訪問前ブリーフィング", "予実分析", "営業活動分析"] },
  { title: "使うときに、何を入力してもらいますか？", hint: "例：会社名、対象期間、営業所名。不明なら「おまかせ」で進められます。", examples: ["会社名", "対象期間", "営業所名", "おまかせ"] },
  { title: "どの情報を参照したいですか？", hint: "例：Salesforce、社内資料、Web、手元の資料。接続が必要な情報は、その条件もSkillに含めます。", examples: ["Salesforce", "Web", "社内資料", "入力した情報だけ"] },
  { title: "進め方や、必ず守りたいことはありますか？", hint: "例：不明なら質問する、数字は推測しない、出典を付ける。", examples: ["不明点は質問する", "数値は推測しない", "出典と未確認事項を明記する", "おまかせ"] },
  { title: "どんな形で結果を出しますか？", hint: "例：会社概要・商談一覧・訪問時の話題候補を、表と箇条書きで。", examples: ["表形式", "箇条書き", "報告書形式", "おまかせ"] },
];
const exclusiveOption = (option: string) => option === "おまかせ" || option === "入力した情報だけ";
export function toggleGeneratorOption(selected: string[], option: string): string[] {
  if (selected.includes(option)) return selected.filter(item=>item!==option);
  return exclusiveOption(option) ? [option] : [...selected.filter(item=>!exclusiveOption(item)),option];
}
export function combineGeneratorAnswer(selected: string[], input: string): string {
  const choices=Array.from(new Set(selected)).join("、");
  const extra=input.trim();
  return choices ? choices+(extra&&!selected.includes(extra)?`\n補足：${extra}`:"") : extra;
}
export interface GeneratorInput { answers: string[]; revision?: string; draft?: SkillInput }

export function validateGeneratorInput(value: unknown): GeneratorInput {
  if (!value || typeof value !== "object") throw new TypeError("作成するSkillの情報を入力してください。");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.answers) || input.answers.length !== GENERATOR_QUESTIONS.length ||
    input.answers.some(answer => typeof answer !== "string" || !answer.trim() || skillBytes(answer) > 1200)) {
    throw new TypeError("5つの質問に、各1,200バイト以内で回答してください。");
  }
  const answers = input.answers.map((answer: string) => answer.trim());
  if (/^(?:おまかせ|わからない|不明)$/.test(answers[0])) throw new TypeError("最初に、作りたいSkillの目的を教えてください。");
  if (input.revision !== undefined || input.draft !== undefined) {
    if (typeof input.revision !== "string" || !input.revision.trim() || skillBytes(input.revision) > 1200 || !input.draft) {
      throw new TypeError("修正したい点を1,200バイト以内で入力してください。");
    }
    return { answers, revision: input.revision.trim(), draft: validateSkill(input.draft) };
  }
  return { answers };
}
