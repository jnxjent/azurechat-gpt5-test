import type { SkillSearchResult } from "./skill-search-policy";

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
    const task = result.returnedObject === "Activity" && String(row.Id ?? "").startsWith("00T");
    // No business-specific Status mapping is assumed. Completion must be checked
    // against the organization's actual Task statuses before calling it pending.
    const open = result.returnedObject === "Opportunity" && ["見積依頼", "見積提示", "契約締結", "作業段取り"].includes(String(row.StageName));
    if (!open && !task) return { ...row };
    const due = day(task ? row.ActivityDate : row.CloseDate), last = day(row.LastActivityDate);
    return { ...row, progressEvidence: {
      asOf: today,
      lastActivityMissing: row.LastActivityDate == null || row.LastActivityDate === "",
      closeDateMissing: row.CloseDate == null || row.CloseDate === "",
      overdueDays: due === undefined ? null : Math.max(0, now - due),
      daysSinceLastActivity: last === undefined ? null : Math.max(0, now - last),
      ...(task ? { taskCompletion: "unverified", instruction: "Taskの状態原文を表示する。完了状態の業務定義未確認のため未完了件数には集計しない。" } : {}),
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
