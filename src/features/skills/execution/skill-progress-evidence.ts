import type { SkillSearchResult } from "./skill-search-policy";
import { progressAmountSummary } from "./skill-progress-amount";

// Calendar days in JST, independent of the server's local time zone.
function day(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const stamp = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) return;
  return stamp / 86_400_000;
}
export function progressEvidence(result: SkillSearchResult, today: string): SkillSearchResult {
  if (result.source !== "salesforce" || result.status !== "ok" || !Array.isArray(result.data)) return result;
  const now = day(today);
  if (now === undefined) return result;
  const rows = result.data.map((value: unknown) => {
    if (!value || typeof value !== "object") return value;
    const row = value as Record<string, unknown>;
    const task = ["Activity", "Task"].includes(result.returnedObject ?? "") && String(row.Id ?? "").startsWith("00T") && (row.object === undefined || row.object === "Task");
    const open = result.returnedObject === "Opportunity" && ["見積依頼", "見積提示", "契約締結", "作業段取り"].includes(String(row.StageName));
    if (!open && !task) return { ...row };
    const due = day(task ? row.ActivityDate : row.CloseDate), last = day(row.LastActivityDate);
    if (task) {
      const taskCompletion = row.IsClosed === true ? "completed" : row.IsClosed === false ? "open" : "unverified";
      return { ...row, progressEvidence: {
        asOf: today, taskCompletion, dueDateMissing: row.ActivityDate == null || row.ActivityDate === "",
        // A past due date alone does not establish an outstanding obligation.
        overdueDays: taskCompletion === "open" && due !== undefined ? Math.max(0, now - due) : null,
        instruction: taskCompletion === "unverified" ? "Taskの完了状態は未確認。Statusの名称から未完了と推測せず、未完了件数に含めない。" : "Task.IsClosedで完了判定。完了済みTaskは期限超過の未完了件数に含めない。",
      } };
    }
    return { ...row, progressEvidence: {
      asOf: today,
      lastActivityMissing: row.LastActivityDate == null || row.LastActivityDate === "",
      closeDateMissing: row.CloseDate == null || row.CloseDate === "",
      overdueDays: due === undefined ? null : Math.max(0, now - due),
      daysSinceLastActivity: last === undefined ? null : Math.max(0, now - last),
    } };
  });
  // Rank only known open opportunities; closed/unknown records retain their order.
  if (result.returnedObject === "Opportunity") rows.sort((a: any, b: any) => {
    const score = (r: any) => r?.progressEvidence;
    const x = score(a), y = score(b);
    if (!x || !y) return Number(Boolean(y)) - Number(Boolean(x));
    // Missing dates are data-quality follow-ups, not evidence of actual inactivity.
    const missing = Number(y.lastActivityMissing || y.closeDateMissing) - Number(x.lastActivityMissing || x.closeDateMissing);
    if (missing) return missing;
    const overdue = Number(y.overdueDays > 0) - Number(x.overdueDays > 0);
    if (overdue) return overdue;
    const days = (y.overdueDays ?? 0) - (x.overdueDays ?? 0);
    if (days) return days;
    const missingActivity = Number(y.lastActivityMissing) - Number(x.lastActivityMissing);
    if (missingActivity) return missingActivity;
    const idle = (y.daysSinceLastActivity ?? -1) - (x.daysSinceLastActivity ?? -1);
    if (idle) return idle;
    return (typeof b.Amount === "number" ? b.Amount : -1) - (typeof a.Amount === "number" ? a.Amount : -1);
  });
  return { ...result, data: rows };
}

// Use a bounded analytical projection only for the server's progress prefetch.
// Snapshot/proof storage keeps the original records; free-text descriptions are
// omitted explicitly instead of silently losing entire opportunities.
export function progressReportEvidence(result: SkillSearchResult, today: string): SkillSearchResult {
  const ranked = progressEvidence(result, today);
  if (ranked.source === "salesforce" && ["ok", "empty"].includes(ranked.status) && ["Activity", "Task", "Event"].includes(ranked.returnedObject ?? "") && Array.isArray(ranked.data)) {
    const summary = { scope: "fetched_records" as const, recordCount: ranked.data.length,
      complete: !ranked.truncated && !ranked.excludedCount && ranked.totalCount === ranked.data.length,
      completedTasks: 0, openTasks: 0, unverifiedTasks: 0, overdueOpenTasks: 0, events: 0, unknownRecords: 0 };
    for (const row of ranked.data) {
      if (row && typeof row === "object" && String(row.Id ?? "").startsWith("00U") && (row.object === undefined || row.object === "Event")) summary.events++;
      else if (row?.progressEvidence?.taskCompletion === "completed") summary.completedTasks++;
      else if (row?.progressEvidence?.taskCompletion === "open") {
        summary.openTasks++;
        if (row.progressEvidence.overdueDays > 0) summary.overdueOpenTasks++;
      } else if (row && typeof row === "object" && String(row.Id ?? "").startsWith("00T") && (row.object === undefined || row.object === "Task")) summary.unverifiedTasks++;
      else summary.unknownRecords++;
    }
    return { ...ranked, activitySummary: summary };
  }
  if (ranked.source !== "salesforce" || !["ok", "empty"].includes(ranked.status) || ranked.returnedObject !== "Opportunity" || !Array.isArray(ranked.data)) return ranked;
  const fields = new Set(["Id", "Name", "AccountId", "AccountName", "Account", "OwnerId", "OwnerName", "Owner", "StageName", "Amount", "CloseDate", "LastActivityDate", "IsClosed", "IsWon", "Probability", "Loss_Reason__c", "NextStep", "lightning_url", "progressEvidence"]);
  const omitted = new Set<string>();
  const stageCounts: Record<string, number> = Object.create(null);
  let rank = 0;
  const data = ranked.data.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    const stage = typeof row.StageName === "string" ? row.StageName : "未取得";
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
    const projected: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(row)) {
      if (!fields.has(key)) { omitted.add(key); continue; }
      // Related records may contain long descriptions as well.
      if ((key === "Account" || key === "Owner") && item && typeof item === "object") {
        projected[key] = Object.fromEntries(Object.entries(item).filter(([field]) => {
          if (field === "Id" || field === "Name") return true;
          omitted.add(key + "." + field); return false;
        }));
      } else projected[key] = item;
    }
    if (row.progressEvidence) projected.progressRank = ++rank;
    return projected;
  });
  return { ...ranked, data, amountSummary: progressAmountSummary(data as Record<string, unknown>[]), progressSummary: {
    scope: "fetched_records", recordCount: data.length,
    complete: !ranked.truncated && !ranked.excludedCount && ranked.totalCount === data.length,
    stageCounts, omittedFields: Array.from(omitted).sort(),
  } };
}
