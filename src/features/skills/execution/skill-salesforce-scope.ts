import { companyForLookup } from "./salesforce-search-query";

export const SKILL_SF_QUERY_LIMIT = 500;
export type SkillSalesforceScope = {
  company?: string; owner?: string;
  period?: string | { start: string; end: string };
  target?: "accounts" | "opportunities" | "activities" | "contacts" | "sales" | "count";
};
const targets = ["accounts", "opportunities", "activities", "contacts", "sales", "count"] as const;
function text(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError("Invalid Salesforce search scope");
  return value.trim().replace(/[\r\n\u0000-\u001f]/g, " ");
}
export function readSkillSalesforceScope(value: unknown): SkillSalesforceScope {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Salesforce search scope");
  const v = value as Record<string, unknown>;
  const company = text(v.company, 120), owner = text(v.owner, 80);
  let period: SkillSalesforceScope["period"];
  if (typeof v.period === "string") period = text(v.period, 100);
  else if (v.period !== undefined) {
    if (!v.period || typeof v.period !== "object" || Array.isArray(v.period)) throw new TypeError("Invalid Salesforce period");
    const p = v.period as Record<string, unknown>;
    const start = text(p.start, 40), end = text(p.end, 40);
    if (!start || !end) throw new TypeError("Invalid Salesforce period");
    period = { start, end };
  }
  if (v.target !== undefined && !targets.includes(v.target as typeof targets[number])) throw new TypeError("Invalid Salesforce target");
  return { company, owner, period, target: v.target as SkillSalesforceScope["target"] };
}
export function resolveSkillSalesforceScope(value: unknown, request: string, legacyCompany?: unknown): SkillSalesforceScope {
  const scope = readSkillSalesforceScope(value);
  const original = request.replace(/^Skill「[^」]+」を使って、\s*/, "");
  scope.company = companyForLookup(original, scope.company ?? legacyCompany);
  const key = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
  if (scope.owner && !key(original).includes(key(scope.owner))) scope.owner = undefined;
  // Compatibility for server-initiated searches and older tool arguments.
  const fallback = original.match(/([^\s、。「」『』:：]{1,30}?)(?:さん|氏)の/)?.[1]?.split("の").pop();
  if (!scope.owner && fallback && !/社|部|の|お客/.test(fallback)) scope.owner = fallback;
  scope.period ??= original.match(/今期|前期|今月|先月|今年度|前年度|昨年度|上期|下期|\d{4}年度/)?.[0];
  return scope;
}
export function buildSkillSalesforceQuery(query: string, scope: SkillSalesforceScope): string {
  const period = typeof scope.period === "string" ? scope.period : scope.period ? `${scope.period.start}～${scope.period.end}` : undefined;
  const labels = { accounts: "取引先", opportunities: "商談", activities: "活動", contacts: "連絡先", sales: "売上", count: "件数" };
  const conditions = [scope.target && `対象: ${labels[scope.target]}`, scope.company && `会社: ${scope.company}`, scope.owner && `担当者: ${scope.owner}`, period && `期間: ${period}`].filter(Boolean).join(" / ");
  // Reserve room for all structured conditions; never prepend the full report request.
  const suffix = conditions ? ` / ${conditions}` : "";
  let prefix = query.replace(/[\r\n\u0000-\u001f]/g, " ").trim().slice(0, Math.max(1, SKILL_SF_QUERY_LIMIT - suffix.length));
  // Avoid a dangling UTF-16 high surrogate at the truncation boundary.
  prefix = prefix.replace(/[\uD800-\uDBFF]$/, "");
  // The signed target contains percent-encoded Japanese; the Gateway also caps
  // the base64 identity header. Bound encoded length, not just visible characters.
  if (encodeURIComponent(suffix).length > 1300) throw new TypeError("Salesforce conditions are too long");
  while (prefix && encodeURIComponent(prefix + suffix).length > 1400) prefix = prefix.slice(0, -1).replace(/[\uD800-\uDBFF]$/, "");
  if (!prefix) throw new TypeError("Salesforce query is too long");
  return prefix + suffix;
}
