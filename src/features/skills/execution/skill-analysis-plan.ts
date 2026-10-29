import type { UserSkill } from "../skill-rules";
import { salesAnalysisProfile, type SalesAnalysisKey } from "../sales-analysis-skills";
import { resolveFiscalPeriod } from "@/lib/fiscal-period";
import { companyForLookup } from "./salesforce-search-query";
import type { SkillSalesforceScope } from "./skill-salesforce-scope";

export type AnalysisRead = { operation: "accounts" | "opportunities" | "activities"; owner?: string; company?: string; request: string; scope: SkillSalesforceScope };
export type AnalysisPlan = { key: SalesAnalysisKey; title: string; limitations: string[]; period?: { start: string; endExclusive: string; expression: string }; reads: AnalysisRead[]; confirmation?: string };
const iso = (value: Date) => value.toISOString().slice(0, 10);

export function analysisPeriod(request: string, today: string): AnalysisPlan["period"] {
  const stamp = new Date(today + "T00:00:00Z");
  if (!Number.isFinite(stamp.getTime()) || iso(stamp) !== today) throw new TypeError("invalid_analysis_date");
  const candidates: Array<{start:string;endExclusive:string}> = [];
  const explicit = request.match(/\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?\s*(?:から|[〜～~])\s*\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?/g) ?? [];
  const relativeTerms=request.match(/今週|先週|今月|先月/g)??[];
  const fiscalTerms=request.match(/今期|前期|今年度|前年度|上期|下期|\d{4}年度/g)??[];
  if((relativeTerms.length&&fiscalTerms.length)||(explicit.length&&(relativeTerms.length||fiscalTerms.length)))throw new TypeError("conflicting_analysis_periods");
  if (explicit.length > 1) throw new TypeError("comparison_requires_separate_periods");
  if (explicit.length) {
    const period = resolveFiscalPeriod(explicit[0]!, stamp);
    if (!period) throw new TypeError("invalid_analysis_period");
    candidates.push({start:period.fiscalStart,endExclusive:period.fiscalEnd});
  } else {
    const months = Array.from(request.matchAll(/(\d{4})年(\d{1,2})月/g));
    if (months.length > 1) throw new TypeError("comparison_requires_separate_periods");
    if (months.length) {
      if(relativeTerms.length||fiscalTerms.length)throw new TypeError("conflicting_analysis_periods");
      const year = +months[0][1], month = +months[0][2];
      if (month < 1 || month > 12 || /\d{1,2}日/.test(request)) throw new TypeError("invalid_analysis_period");
      candidates.push({start:iso(new Date(Date.UTC(year,month-1,1))),endExclusive:iso(new Date(Date.UTC(year,month,1)))});
    } else {
      if (/\d{4}[年/-]\d/.test(request)) throw new TypeError("incomplete_analysis_period");
      const relatives = Array.from(new Set(request.match(/今週|先週|今月|先月/g) ?? []));
      if (relatives.length > 1) throw new TypeError("comparison_requires_separate_periods");
      if (relatives.length) {
        const term = relatives[0];
        if (term.endsWith("週")) {
          const monday = new Date(stamp); monday.setUTCDate(stamp.getUTCDate() - (stamp.getUTCDay()+6)%7 - (term === "先週" ? 7 : 0));
          candidates.push({start:iso(monday),endExclusive:iso(new Date(monday.getTime()+7*86400000))});
        } else {
          const offset = term === "先月" ? -1 : 0, year=stamp.getUTCFullYear(), month=stamp.getUTCMonth()+offset;
          candidates.push({start:iso(new Date(Date.UTC(year,month,1))),endExclusive:iso(new Date(Date.UTC(year,month+1,1)))});
        }
      } else {
        const fiscal=resolveFiscalPeriod(request,stamp);
        if (fiscal) candidates.push({start:fiscal.fiscalStart,endExclusive:fiscal.fiscalEnd});
        else if (/年度|今期|前期|上期|下期|最近|直近|週|月間/.test(request)) throw new TypeError("ambiguous_analysis_period");
      }
    }
  }
  if (!candidates.length) return;
  const period=candidates[0],last=iso(new Date(Date.parse(period.endExclusive)-86400000));
  return {...period,expression:`${period.start}～${last}`};
}

export function planAnalysisSkill(skills: UserSkill[], raw: string, today: string): AnalysisPlan | undefined {
  const profile=salesAnalysisProfile(skills); if (!profile) return;
  const request=raw.replace(/^Skill「[^」]+」を使って、\s*/, "");
  const plan: AnalysisPlan={key:profile.key,title:profile.title,reads:[],limitations:["本人の現在の参照権限で取得。商談区分は暫定。Amountは売上・予算・原価ではなく、通貨・税区分未確認。"]};
  const stop=(message:string) => ({...plan,confirmation:message});
  if (/Salesforce.*(?:使わ|使用しない|検索しない|除外)|(?:Web|社内資料)(?:だけ|のみ)/i.test(request)) return;
  if (/以外|除く|除外|以上|以下|未満|金額順|上位|下位|停滞|地域|業種|確度.{0,6}[%％]|部下|全社|営業所全体|比較|前月比|前年比|予算|原価|売上/.test(request)) return stop("指定された追加条件・比較・売上等は、この分析の取得条件へまだ対応していません。条件を削って代用せず、必要な範囲・基準を確認してください。");
  try { plan.period=analysisPeriod(request,today); } catch { return stop("分析する期間を開始日と終了日で1つ指定してください。曖昧な期間・不正日付・複数期間を自動補完しません。"); }
  if (["outcomes","activity","weekly","monthly"].includes(plan.key) && !plan.period) return stop("分析する期間を指定してください（例：今週、今月、2026年10月1日から2026年10月29日まで）。");
  if (plan.key === "account") {
    if (plan.period) return stop("取引先基本情報には期間の基準がありません。商談・活動の期間分析とは分けて指定してください。");
    const company=companyForLookup(request);
    if (!company) return stop("取引先情報を確認する会社名を指定してください。");
    plan.reads.push({operation:"accounts",company,scope:{target:"accounts",company,unsupportedConditions:[]},request:`「${company}」の取引先情報`});
    return plan;
  }
  const list=request.match(/対象担当者\s*[：:]\s*([^。\n;；]+)/)?.[1];
  let owners=list ? list.split(/[、,，]/).map(name=>name.trim().replace(/(?:さん|氏)$/,"")) : Array.from(request.matchAll(/([^、。「」『』:：\n]{1,30}?)(?:さん|氏)の/g)).map(match=>match[1].split("の").pop()!.trim());
  if (!owners.length && /私の|自分の|本人の/.test(request)) owners=["本人"];
  owners=Array.from(new Set(owners));
  if (!owners.length || owners.length>3 || owners.some(owner=>!owner || owner.length>30 || /[<>\n]|(?:全員|営業所|部下|など)/.test(owner))) return stop("対象の担当者を指定してください。複数人は『対象担当者：黄、甲斐』の形式で3名まで指定できます。営業所所属・部下範囲は推測しません。");
  if (["office","monthly"].includes(plan.key)) {
    if (!list) return stop("営業所の所属項目は業務確認待ちです。対象担当者を『対象担当者：黄、甲斐』の形式で指定してください。");
    plan.limitations.push("明示された担当者だけの集計。営業所の全所属者を確認した集計ではありません。売上の所属・担当者帰属も未確認。");
  }
  // Refuse unrecognised predicates rather than stripping them from a read.
  let residue=request.replace(/対象担当者\s*[：:]\s*[^。\n;；]+/,"");
  for(const owner of owners) residue=residue.split(owner).join("");
  residue=residue.replace(/\d{4}年\d{1,2}月(?:\d{1,2}日?)?|\d{4}[/-]\d{1,2}[/-]\d{1,2}|今週|先週|今月|先月|今期|前期|今年度|前年度|上期|下期|\d{4}年度/g,"");
  residue=residue.replace(/AI営業部長|営業所月次分析|営業所マネジメント分析|営業所管理|週ミーティング|営業進捗管理|成約失注分析|営業活動分析|Salesforce|セールスフォース|商談|活動|成約|失注理由|失注|進行中|全段階|営業|進捗|状況|分析|レポート|課題|次の行動|行動|提案|議題|作成|報告|まとめて|纏めて|作って|出して|要約|整理|確認|教えて|ください|対象|担当者|形式|もとに|さん|氏|私|自分|本人|から|まで|について|して|する|を|の|と|で|に|は|期間|[\s。、：:〜～~・()（）「」『』]/gi,"");
  if (residue) return stop("この依頼には未対応の条件や表現が含まれています。対象担当者・期間・商談または活動を明示して指定してください。条件を黙って削って検索はしません。");
  const stageWords=Array.from(new Set(request.match(/進行中|成約|失注(?!理由)|全段階/g)??[]));
  if(stageWords.length>1 && !(plan.key==="outcomes"&&stageWords.every(word=>word==="成約"||word==="失注"))) return stop("複数の段階条件が指定されています。成約失注分析以外では段階を1つ指定するか、全段階と指定してください。");
  const operations = plan.key === "activity" ? ["activities"] as const : ["opportunities", ...(["outcomes"].includes(plan.key)?[]:["activities"])] as Array<"opportunities"|"activities">;
  for (const owner of owners) for (const operation of operations) {
    const noun=operation === "opportunities" ? "商談" : "活動";
    const period=plan.period?.expression;
    const stage=operation === "opportunities" && plan.key!=="outcomes" && stageWords.length===1 ? stageWords[0] as SkillSalesforceScope["stage"] : undefined;
    const canonical=`${owner}の${noun}一覧${period?`。期間：${period}`:""}${stage?`。段階：${stage}`:""}`;
    plan.reads.push({operation,owner,request:canonical,scope:{target:operation,owner,period,stage,unsupportedConditions:[]}});
  }
  return plan;
}
