import type { SkillSearchResult } from "./skill-search-policy";
import { SKILL_SEARCH_LIMITS } from "./skill-search-policy";

// Limit context growth separately from the per-message budget. Progress reads
// are all-or-error: never remove records to make a report appear successful.
export const PROGRESS_INPUT_BYTES = 128_000;
export const PROGRESS_REPORT_BYTES = 256_000;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
export function progressContextWithinBudget(messages: unknown[]): boolean { return bytes(messages) <= PROGRESS_REPORT_BYTES; }

export function progressResultPages(result: SkillSearchResult): SkillSearchResult[] {
  if (!Array.isArray(result.data) || bytes(result) <= SKILL_SEARCH_LIMITS.resultBytes) return [result];
  if (!result.data.length) throw new RangeError("progress_metadata_too_large");
  const pages: SkillSearchResult[] = [];
  let data: unknown[] = [];
  for (const row of result.data) {
    const candidate = { ...result, data: [...data, row] };
    if (bytes(candidate) > SKILL_SEARCH_LIMITS.resultBytes) {
      if (!data.length) throw new RangeError("progress_record_too_large");
      pages.push({ ...result, data });
      data = [row];
      if (bytes({ ...result, data }) > SKILL_SEARCH_LIMITS.resultBytes) throw new RangeError("progress_record_too_large");
    } else data.push(row);
  }
  if (data.length) pages.push({ ...result, data });
  // Include repeated metadata in the total context budget as well.
  if (pages.reduce((sum, page) => sum + bytes(page), 0) > PROGRESS_INPUT_BYTES) throw new RangeError("progress_input_too_large");
  return pages;
}

export function boundProgressResult(result: SkillSearchResult): SkillSearchResult {
  if (result.source !== "salesforce" || !["ok", "empty"].includes(result.status) || !Array.isArray(result.data)) return result;
  const completeInput = { ...result, modelVisibleCount: result.data.length };
  try {
    if (bytes(completeInput) > PROGRESS_INPUT_BYTES) throw new RangeError("progress_input_too_large");
    progressResultPages(completeInput);
    return completeInput;
  } catch {
    return { source: result.source, status: "limit", reason: "progress_input_too_large",
      fetchedCount: result.fetchedCount ?? result.data.length, totalCount: result.totalCount,
      returnedObject: result.returnedObject, appliedFilters: result.appliedFilters,
      modelVisibleCount: 0, data: [], truncated: true,
      message: "取得済みの全明細をAI入力へ渡せないため、この検索の分析は中止しました。一部の商談を削って成功とは扱いません。対象・期間を絞って再検索してください。取得件数を0件と扱わないでください。" };
  }
}

function cell(value: unknown): string {
  return String(value ?? "未取得").replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");
}
function recordLink(row: Record<string, any>): string {
  const label = cell(row.Name ?? row.Id);
  try {
    const url = new URL(row.lightning_url);
    if (url.protocol === "https:" && !url.username && !url.password) return `[${label}](<${url.href.replace(/>/g, "%3E")}>)`;
  } catch { /* Display the record name without inventing a URL. */ }
  return label;
}
function reason(row: Record<string, any>): string {
  const evidence = row.progressEvidence;
  const reasons: string[] = [];
  if (evidence.lastActivityMissing) reasons.push("最終活動日未入力");
  if (evidence.closeDateMissing) reasons.push("予定日未入力");
  if (evidence.overdueDays > 0) reasons.push(`予定日${evidence.overdueDays}日超過`);
  if (evidence.daysSinceLastActivity != null) reasons.push(`最終活動から${evidence.daysSinceLastActivity}日`);
  return reasons.join("、") || "取得した日付・金額による確認順";
}
function action(row: Record<string, any>): string {
  const evidence = row.progressEvidence;
  if (evidence.lastActivityMissing || evidence.closeDateMissing) return "未入力の日付と現在の状況を確認";
  if (evidence.overdueDays > 0) return "現在の進捗と予定日の見直しを確認";
  return "次回の活動予定と進捗を確認";
}

/** One source of truth for the ranked sections, shared by Web persistence and Teams. */
export function progressRankingMarkdown(result: SkillSearchResult, displayLimit = 20): string {
  if (result.status !== "ok" || result.returnedObject !== "Opportunity" || !Array.isArray(result.data) || result.modelVisibleCount !== result.data.length) return "";
  const rows = result.data.filter(row => row && Number.isInteger(row.progressRank) && row.progressEvidence);
  if (!rows.length) return "";
  const top = rows.slice(0, 3).map(row => `${row.progressRank}. ${recordLink(row)}：${reason(row)}。提案：${action(row)}。`).join("\n");
  const table = rows.slice(0, displayLimit).map(row => `| ${row.progressRank} | ${cell(row.AccountName ?? row.Account?.Name)} | ${recordLink(row)} | ${cell(row.StageName)} | ${typeof row.Amount === "number" && Number.isFinite(row.Amount) ? row.Amount.toLocaleString("ja-JP") : "未取得"} | ${cell(row.CloseDate)} | ${reason(row)} |`).join("\n");
  const followups = rows.slice(0, 5).map(row => `| ${row.progressRank} | ${recordLink(row)} | ${action(row)} |`).join("\n");
  return ["## 営業進捗の確認順（サーバー集計）",
    `この検索の取得${result.fetchedCount ?? result.data.length}件、AI入力${result.modelVisibleCount}件。確認順位は取得明細内の暫定基準です。${result.truncated ? "上流の取得上限があるため、全商談の順位ではありません。" : ""}`,
    ...(result.amountSummary ? [`取得したAmount値の合計：${result.amountSummary.valueSum ?? "未取得"}（金額あり${result.amountSummary.valuedRecords}件、欠損${result.amountSummary.missingRecords}件、不正${result.amountSummary.invalidRecords}件）。通貨・税区分は未確認。売上実績・予算の合計ではありません。`] : []),
    "### 最優先3件", top,
    `### 進行中商談一覧（${Math.min(rows.length, displayLimit)}件掲載／分析対象${rows.length}件）`,
    "| 確認順位 | 取引先 | 商談 | 段階 | 商談金額（取得値） | 予定日 | 確認理由 |",
    "| --- | --- | --- | --- | ---: | --- | --- |", table,
    "### 優先フォローアップ（提案）", "| 確認順位 | 商談 | 次の行動 |", "| --- | --- | --- |", followups,
  ].join("\n\n").replace(/\|\n\n\|/g, "|\n|");
}
