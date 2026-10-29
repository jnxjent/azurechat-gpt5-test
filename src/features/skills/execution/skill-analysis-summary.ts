import type { AnalysisPlan, AnalysisRead } from "./skill-analysis-plan";
import type { SkillSearchResult } from "./skill-search-policy";
import { progressAmountSummary } from "./skill-progress-amount";

export function summarizeAnalysisRead(result: SkillSearchResult) {
  const rows=Array.isArray(result.data)?result.data:[];
  const success=["ok","empty"].includes(result.status);
  const complete=success && !result.truncated && !result.excludedCount && result.totalCount===rows.length;
  const base={status:result.status,reason:result.reason??null,fetched:result.fetchedCount??rows.length,modelInput:result.modelVisibleCount??rows.length,total:result.totalCount??null,complete,appliedFilters:result.appliedFilters??null};
  if (!success) return {...base,metrics:null};
  if (result.returnedObject === "Opportunity") {
    const classes={open:0,won:0,lost:0,unclassified:0};
    const reasons: Record<string,number>=Object.create(null);
    for (const row of rows) {
      const stage=String(row.StageName??"");
      if (stage==="作業完了") classes.won++;
      else if (stage.includes("失注")) {classes.lost++;const reason=typeof row.Loss_Reason__c==="string"&&row.Loss_Reason__c.trim()?row.Loss_Reason__c.trim():"未入力";reasons[reason]=(reasons[reason]??0)+1;}
      else if (["見積依頼","見積提示","契約締結","作業段取り"].includes(stage)) classes.open++;
      else classes.unclassified++;
    }
    return {...base,metrics:{...classes,closedWonShare:classes.won+classes.lost ? classes.won/(classes.won+classes.lost):null,ratioScope:"取得した成約＋失注のみ。全商談の成約率ではない",lossReasons:reasons,amount:progressAmountSummary(rows),stageDefinition:"暫定（現場確認待ち）"}};
  }
  if (["Activity","Task","Event"].includes(result.returnedObject??"")) return {...base,metrics:result.activitySummary??null};
  return {...base,metrics:{recordCount:rows.length}};
}
const cell=(value:unknown)=>String(value??"未取得").replace(/[\r\n|]/g," ").replace(/[\\`*_[\]<>]/g,"\\$&");
export function analysisSummaryMarkdown(plan: AnalysisPlan, results: Array<{read:AnalysisRead;result:SkillSearchResult}>): string {
  const lines=[`## ${plan.title}：取得範囲と集計`,plan.period ? `対象期間：${plan.period.start}以上・${plan.period.endExclusive}未満。商談はCloseDate、活動はActivityDateを使用。` : "期間指定なしの現況。取引先基本情報には期間を適用しません。",
    ...plan.limitations.map(message=>`- ${message}`),
    "| 対象 | データ | 取得件数 | AI入力件数 | 対象総件数 | 状態 |", "| --- | --- | ---: | ---: | --- | --- |"];
  for(const {read,result} of results) {
    const summary=summarizeAnalysisRead(result);
    lines.push(`| ${cell(read.owner??read.company)} | ${read.operation} | ${summary.fetched} | ${summary.modelInput} | ${summary.total??"未確定"} | ${summary.complete?"全件取得":cell(summary.status)+"・一部または未確認"} |`);
  }
  for(const {read,result} of results) {
    const summary=summarizeAnalysisRead(result);
    if(!summary.metrics) {lines.push(`\n${cell(read.owner??read.company)}：この検索の分析は未取得（${cell(result.reason??result.status)}）。0件ではありません。`);continue;}
    if(result.returnedObject==="Opportunity") {
      const metrics=summary.metrics as ReturnType<typeof summarizeAnalysisRead>["metrics"] & {open:number;won:number;lost:number;unclassified:number;closedWonShare:number|null;amount:ReturnType<typeof progressAmountSummary>};
      lines.push(`\n${cell(read.owner)}の取得商談内訳（暫定）：進行中${metrics.open}件、成約${metrics.won}件、失注${metrics.lost}件、分類外${metrics.unclassified}件。取得した成約＋失注に占める成約割合：${metrics.closedWonShare===null?"算出対象なし":(metrics.closedWonShare*100).toFixed(1)+"%"}。${summary.complete?"":"取得範囲だけの内訳であり、対象全体の値ではありません。"}`);
      lines.push(`取得Amount値の合計：${metrics.amount.valueSum??"未取得"}（金額あり${metrics.amount.valuedRecords}件、欠損${metrics.amount.missingRecords}件）。通貨・税区分未確認。`);
    } else if (result.activitySummary) {
      const a=result.activitySummary;
      lines.push(`\n${cell(read.owner)}の取得活動内訳：完了Task${a.completedTasks}件、未完了Task${a.openTasks}件、状態未確認Task${a.unverifiedTasks}件、Event${a.events}件、種別不明${a.unknownRecords}件。期限超過の未完了Task${a.overdueOpenTasks}件。${summary.complete?"":"取得範囲だけの内訳です。"}`);
    }
  }
  return lines.join("\n");
}
