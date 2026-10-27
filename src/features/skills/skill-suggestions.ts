import { skillName, type UserSkill } from "./skill-rules";

export type SkillSuggestion = Pick<UserSkill, "id" | "title" | "description" | "enabled" | "version" | "scope" | "ownerName">;
const stopWords = new Set("レポート 報告書 作成 まとめ 整理 情報 確認 お願い ください したい する できる について ため 使って スキル skill report the and for with 株式会社".split(" "));
function matchingText(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/ブリーフィング|briefing|\bvisit\b|客先|商談準備/g, "訪問")
    .replace(/進み具合|営業状況/g, "進捗").replace(/売り上げ|\bsales\b/g, "売上")
    .replace(/\bopportunity\b/g, "商談").replace(/meeting\s*minutes/g, "議事録")
    .replace(/\bproposal\b/g, "提案").replace(/\bcompetitive\b/g, "競合");
}
function features(value: string): string[] {
  const text = matchingText(value);
  const words: string[] = [];
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
    Array.from(segmenter.segment(text)).forEach(part => { if (part.isWordLike && part.segment.length >= 2 && !stopWords.has(part.segment)) words.push(part.segment); });
  }
  // Character pairs also match compounds and work on browsers without Segmenter.
  for (const part of text.match(/[一-龥々]{2,}|[ァ-ヶー]{2,}|[a-z][a-z0-9]+/g) ?? []) {
    if (stopWords.has(part)) continue;
    words.push(part);
    if (!/^[a-z]/.test(part)) for (let index = 0; index < part.length - 1; index++) words.push(part.slice(index, index + 2));
  }
  return Array.from(new Set(words.filter(word => !stopWords.has(word))));
}
/** Local metadata matching only: typing never executes a Skill or sends the draft to a model. */
export function suggestSkills(skills: SkillSuggestion[], draft: string): SkillSuggestion[] {
  const text = draft.normalize("NFKC").trim();
  if (text.length < 4 || text.length > 4000 || /(?:Skill|スキル)\s*[「『]|(?:Skill|スキル).*(?:保存|作成|削除|編集|一覧)|訪問(?:しない|しません|不要)/i.test(text)) return [];
  const normalized = skillName(text);
  const wanted = features(text);
  const catalog = skills.filter(s => s.enabled && !/[「」『』\n]/.test(s.title)).map(skill => ({ skill, title: matchingText(skill.title), description: matchingText(skill.description) }));
  const frequency = wanted.map(word => catalog.filter(entry => entry.title.includes(word) || entry.description.includes(word)).length);
  return catalog.map(entry => {
    const skill = entry.skill;
    const title = skillName(skill.title);
    const weights = wanted.map((word, index) => (entry.title.includes(word) ? 4 : entry.description.includes(word) ? 2 : 0) * (1 + Math.log((catalog.length + 1) / (frequency[index] + 1))));
    const score = (title.length > 2 && normalized.includes(title) ? 100 : 0) + weights.sort((a,b) => b-a).slice(0,5).reduce((sum,weight) => sum+weight,0);
    return { skill, score };
  }).filter(s => s.score >= 2).sort((a, b) => b.score - a.score || Number(a.skill.scope === "shared") - Number(b.skill.scope === "shared") || a.skill.title.localeCompare(b.skill.title, "ja") || a.skill.id.localeCompare(b.skill.id)).slice(0, 3).map(s => s.skill);
}

export function applySkillSuggestion(draft: string, skill: SkillSuggestion): string {
  // Titles are quoted by the existing explicit-selection parser.
  return `Skill「${skill.title}」を使って、${draft}`;
}

export function notifySkillCatalogChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("azurechat:skills-changed"));
  try { window.localStorage.setItem("azurechat:skills-changed", String(Date.now())); } catch { /* Storage can be disabled. */ }
}

export function skillSuggestionKey(key: string, shift: boolean, composing: boolean, visible: boolean): "accept" | "dismiss" | "next" | "previous" | undefined {
  if (!visible || composing || shift) return undefined;
  return key === "Tab" ? "accept" : key === "Escape" ? "dismiss" : key === "ArrowDown" ? "next" : key === "ArrowUp" ? "previous" : undefined;
}
