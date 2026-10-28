import type { SkillSalesforceScope } from "./skill-salesforce-scope";

export class SkillReadV2UnsupportedError extends TypeError {
  readonly reason = "v2_unsupported_conditions";
  constructor(readonly diagnosticCode = "unsupported_target") { super(
    diagnosticCode === "period_not_in_request"
      ? "検索ツールのperiodに利用者が指定していない期間が追加されています。利用者の期間指定がなければperiodを省略して現況を検索してください。『未指定』『全期間』『なし』などの文字列もperiodへ入れません。期間分析は未取得と明記し、実際に指定された期間は削除しないでください。"
      : "この検索の条件は型付きV2で処理できません。旧検索へ切り替えず中止しました。元の条件を削って再検索せず、未取得の項目として明記してください。0件ではありません。"); }
}

/** Structured list contract. Unsupported constraints fail closed, never route to NL. */
export function buildTypedSkillReadV2(query: string, request: string, scope: SkillSalesforceScope, operation: string, accountId?: string) {
  if (process.env.SF_SKILL_READ_V2_ENABLED !== "true" || !["accounts", "opportunities", "activities"].includes(operation)) return;
  const original = request.replace(/^Skill「[^」]+」を使って、\s*/, "");
  const unsupported = (code = "unsupported_filter") => { throw new SkillReadV2UnsupportedError(code); };
  // Display columns (金額・確度・失注理由) are not filters. Never classify by
  // leftover prose; structured scope selects the route, while unsupported
  // predicates fail closed instead of silently falling back to query_nl.
  const predicates = /以外|除く|ではない|含めない|そのうち|その中で|先ほど|さっき|直前|部下|チーム|配下|直属|営業所|以上|以下|未満|超える|万円|円以上|地域|業種|並べ|上位|下位|停滞|動いて|金額順|確度順|確率順|確度.{0,8}[%％]|確率.{0,8}[%％]/;
  if (scope.unsupportedConditions?.length) unsupported("structured_conditions");
  if (predicates.test(query) || predicates.test(original)) unsupported("predicate_not_supported");
  const noun = { accounts: /取引先|Account/i, opportunities: /商談|Opportunity/i, activities: /活動|Activity|Task|Event/i }[operation as "accounts" | "opportunities" | "activities"];
  const objectEvidence = query.match(noun)?.[0];
  const typedObjectEvidence = objectEvidence ?? ({accounts:"取引先",opportunities:"商談",activities:"活動"} as Record<string,string>)[operation];
  const owner = scope.owner;
  if (owner && !original.includes(owner)) unsupported();
  const self = Boolean(owner && /^(私|自分|本人|self)$/.test(owner)) || /(?:私|自分|本人)の/.test(original);
  if (!owner && !self && !accountId && !scope.company) unsupported("missing_scope");
  if (scope.company && !original.includes(scope.company)) unsupported();
  const periodText = typeof scope.period === "string" ? scope.period : original.match(/直近\d+(?:日|か月|ヶ月|カ月)|今期|当期|前期|今月|先月|今年度|前年度|昨年度|上期|下期|\d{4}年度/)?.[0];
  if (scope.period && !periodText) unsupported("unresolved_period");
  if (periodText && !original.includes(periodText)) unsupported("period_not_in_request");
  if (periodText && !/^(?:今期|当期|今年度|本年度|前期|前年度|昨年度|来期|来年度|上期|上半期|下期|下半期|今月|先月|\d{4}年度|直近[1-9]\d*(?:日|か月|ヶ月|カ月)|\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?\s*(?:から|[〜～~])\s*\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?)$/.test(periodText)) return;
  if (periodText && operation === "accounts") unsupported(); // Needs an explicit date basis.
  if (/最近/.test(query) && !periodText) unsupported("ambiguous_period");
  const stageMatches = (text: string) => Array.from(text.matchAll(/進行中|成約|失注(?!理由)|全段階/g)).map(m => m[0]);
  const terms = Array.from(new Set(stageMatches(query).length ? stageMatches(query) : stageMatches(original)));
  if (scope.stage && operation !== "opportunities") unsupported("stage_object_mismatch");
  if (operation === "opportunities" && !scope.stage && terms.length > 1) unsupported("multiple_stages");
  const stageWord = operation === "opportunities" ? scope.stage ?? (terms.length === 1 ? terms[0] : undefined) : undefined;
  const requestedStages = Array.from(new Set(stageMatches(original)));
  if (stageWord && requestedStages.length === 1 && requestedStages[0] !== "全段階" && stageWord !== requestedStages[0]) unsupported("stage_conflict");
  const stage = stageWord && stageWord !== "全段階" ? { value: ({進行中:"open",成約:"won",失注:"lost"} as Record<string,string>)[stageWord], evidence: stageWord } : null;
  const evidence = original + " / 個別検索: " + query + " / 種類: " + typedObjectEvidence + (stage ? " / 段階: " + stageWord : "");
  const plan = {
    version: "SF_READ_PLAN_V2", route: "records", specialist: null,
    object: ({accounts:"Account",opportunities:"Opportunity",activities:"Activity"} as Record<string,string>)[operation],
    object_evidence: typedObjectEvidence, action: "list",
    owner: { scope: self ? "self" : owner ? "named_user" : "all", name: self ? null : owner ?? null,
      name_evidence: !self && owner ? owner : null, include_self: self, negated_scope: null,
      evidence: self ? original.match(/私|自分|本人/)?.[0] ?? null : owner ?? null },
    account: { name: scope.company ?? null, evidence: scope.company ?? null },
    period: periodText ? {field:operation === "activities" ? "ActivityDate" : "CloseDate",expression:periodText,evidence:periodText} : null,
    stage, stale:null, conditions:[], group_by:[], aggregate:null, sort:null, limit:null,
    context_mode:"new", unhandled_requirements:[], clarification:null,
  };
  return { planVersion:"SF_READ_PLAN_V2",query:evidence,plan,...(accountId ? {accountId} : {}) };
}
