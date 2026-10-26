import { skillName, type UserSkill } from "./skill-rules";

export type SkillSuggestion = Pick<UserSkill, "id" | "title" | "description" | "enabled" | "version">;
const intents = [
  { query: /訪問|客先|商談準備|visit|briefing/i, catalog: /訪問|客先|ブリーフィング|briefing|visit/i },
  { query: /議事録|会議.*まとめ|meeting.*minutes/i, catalog: /議事録|会議|minutes/i },
  { query: /提案書|提案資料|proposal/i, catalog: /提案|proposal/i },
  { query: /競合|競争|competitive/i, catalog: /競合|競争|competitive/i },
];
/** Local metadata matching only: typing never executes a Skill or sends the draft to a model. */
export function suggestSkills(skills: SkillSuggestion[], draft: string): SkillSuggestion[] {
  const text = draft.normalize("NFKC").trim();
  if (text.length < 4 || text.length > 4000 || /(?:Skill|スキル)\s*[「『]|(?:Skill|スキル).*(?:保存|作成|削除|編集|一覧)|訪問(?:しない|しません|不要)/i.test(text)) return [];
  const normalized = skillName(text);
  return skills.filter(s => s.enabled && !/[「」『』\n]/.test(s.title)).map(skill => {
    const catalog = `${skill.title} ${skill.description}`.normalize("NFKC");
    const title = skillName(skill.title);
    const score = (title.length > 2 && normalized.includes(title) ? 10 : 0)
      + intents.filter(i => i.query.test(text) && i.catalog.test(catalog)).length * 4
      + (skill.description.match(/[a-z]{4,}|[一-龥]{2,6}/gi) ?? []).filter(word => text.toLowerCase().includes(word.toLowerCase())).slice(0, 3).length;
    return { skill, score };
  }).filter(s => s.score >= 4).sort((a, b) => b.score - a.score || a.skill.title.localeCompare(b.skill.title, "ja")).slice(0, 3).map(s => s.skill);
}

export function applySkillSuggestion(draft: string, skill: SkillSuggestion): string {
  // Titles are quoted by the existing explicit-selection parser.
  return `Skill「${skill.title}」を使って、${draft}`;
}

export function skillSuggestionKey(key: string, shift: boolean, composing: boolean, visible: boolean): "accept" | "dismiss" | undefined {
  if (!visible || composing || shift) return undefined;
  return key === "Tab" ? "accept" : key === "Escape" ? "dismiss" : undefined;
}
