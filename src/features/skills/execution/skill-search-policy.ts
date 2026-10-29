export const SKILL_SEARCH_LIMITS = { calls: 8, rounds: 6, searchMilliseconds: 90_000, reportMilliseconds: 120_000, milliseconds: 210_000, resultBytes: 16_000, queryCharacters: 600 } as const;

export type SearchSource = "salesforce" | "web" | "documents";
export type SearchStatus = "ok" | "empty" | "denied" | "unavailable" | "error" | "limit" | "needs_confirmation";
export type SkillSearchResult = { source: SearchSource; status: SearchStatus; message?: string; data?: unknown; truncated?: boolean; reason?: string; httpStatus?: number; excludedCount?: number; queryCount?: number; authoritativeText?: string; returnedObject?: string; requestedTarget?: string; planVersion?: string; fetchedCount?:number; totalCount?:number|null; modelVisibleCount?:number; appliedFilters?:unknown; progressSummary?: { scope: "fetched_records"; recordCount: number; complete: boolean; stageCounts: Record<string, number>; omittedFields: string[] }; activitySummary?: { scope: "fetched_records"; recordCount: number; complete: boolean; completedTasks: number; openTasks: number; unverifiedTasks: number; overdueOpenTasks: number; events: number; unknownRecords: number } };

export function shouldRunSkillSearch(selectedCount: number): boolean {
  return process.env.SKILL_SEARCH_ENABLED === "true" && selectedCount > 0;
}

export function validateSearchQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > SKILL_SEARCH_LIMITS.queryCharacters) {
    throw new TypeError("検索条件は1〜600文字で指定してください。");
  }
  return value.trim();
}

// Preserve valid JSON and explicitly disclose omitted results, never slice serialized JSON.
export function boundSearchResult(result: SkillSearchResult): SkillSearchResult {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= SKILL_SEARCH_LIMITS.resultBytes) return result;
  if (Array.isArray(result.data)) {
    const copy = { ...result, data: [...result.data], modelVisibleCount:result.data.length, truncated: true };
    while (copy.data.length && Buffer.byteLength(JSON.stringify(copy), "utf8") > SKILL_SEARCH_LIMITS.resultBytes) {copy.data.pop();copy.modelVisibleCount=copy.data.length;}
    if (Buffer.byteLength(JSON.stringify(copy), "utf8") <= SKILL_SEARCH_LIMITS.resultBytes) return copy;
  }
  return { source: result.source, status: "limit", truncated: true, message: "検索結果が大きすぎます。条件・期間を絞って再検索してください。全件を取得したものとして集計しないでください。" };
}
