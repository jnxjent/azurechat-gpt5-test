/** Shared Web/Teams/Skills interpretation of authoritative Gateway metadata. */
export const salesforceReadInstruction = "表示されているページの行数から件数や合計を計算してはいけません。total_countがnull・未設定なら総件数は不明です。countとreturned_countは表示件数です。truncated=trueでもCOUNT()で確認した総件数があれば、その値だけを総件数として使えます。候補や解析失敗を0件として扱ってはいけません。";

const errorMessages: Record<string, string> = {
  semantic_plan_unavailable: "一時的に依頼文を解析できません。少し待って再度お試しください。",
  owner_scope_unavailable: "部下の担当範囲、または検索の基準となる本人を確認できませんでした。本人の担当分で代用せず、検索を中止しました。",
  identity_unavailable: "有効なSalesforce本人を確認できません。管理者に接続を確認してください。",
  permission_denied: "対象を参照する権限を確認できません。管理者にお問い合わせください。",
  field_unresolved: "対象の項目を特定できません。Salesforceの表示名または候補のAPI名を指定してください。",
  account_unresolved: "指定した取引先が見つかりません。会社名・拠点名を確認してください。",
  unsupported_condition: "指定された条件を検索へ反映できません。対象と条件を確認してください。",
  invalid_structure: "検索条件を確認できません。『取引先の件数』のように指定してください。",
  context_missing: "引き継ぐ検索条件がありません。対象と条件を含めて質問してください。",
  context_conflict: "引き継ぐ条件と今回の条件が矛盾しています。置き換える対象・条件を指定してください。",
  salesforce_query_rejected: "Salesforceが検索を受け付けませんでした。管理者に項目と条件の確認を依頼してください。",
  invalid_count_response: "件数の取得結果を確認できません。再度お試しください。",
};

function filtersText(filters: unknown): string {
  return Array.isArray(filters) && filters.length ? filters.map(f => `${String(f.label)} ${String(f.op)} ${typeof f.value === "boolean" ? f.value ? "チェックあり" : "チェックなし" : String(f.value)}`).join("、") : "なし";
}

function summaryText(summary: any): string {
  const target = summary?.object === "User" ? "ユーザー" : "取引先";
  const scope = summary?.scope === "all" ? `接続ユーザーの参照権限内の全${target}` : summary?.scope_notice || "指定した担当範囲";
  return `対象：${scope}${summary?.account_id ? `（Account ID：${summary.account_id}）` : ""}\n条件：${filtersText(summary?.filters)}\n集計・取得方法：${summary?.method || "未確認"}${summary?.user_type_policy ? `\nユーザー種別：${summary.user_type_policy}` : ""}`;
}

export function salesforceReadText(body: any): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const kind = body.error_kind || body.error;
  if (kind && errorMessages[kind]) {
    const message = typeof body.clarification === "string" ? body.clarification : errorMessages[kind];
    const choices = Array.isArray(body.field_candidates) ? body.field_candidates.map((f: any) => `- ${f.label}（${f.api_name}）`).join("\n") : "";
    return message + (choices ? `\n\n${choices}` : "");
  }
  if (body.status === "conversation") return "どうぞ、ご質問ください。";
  if (body.status === "query_explanation" && body.query_explanation) return `直前の検索条件は次のとおりです。\n\n${summaryText(body.query_explanation)}`;
  const aggregate = body.aggregation_result;
  if (aggregate?.func === "COUNT" && aggregate.source === "soql_count" && Number.isSafeInteger(aggregate.value) && aggregate.value >= 0) {
    const user = body.object === "User";
    const summary = body.execution_summary || body.context_applied?.summary || { object: body.object, scope: aggregate.scope, filters: aggregate.filters_summary, method: "Salesforce COUNT()" };
    const fields = Array.isArray(body.resolved_fields) && body.resolved_fields.length ? `\n対象項目：${body.resolved_fields.map((f: any) => `${f.label}（${f.api_name}）`).join("、")}` : "";
    return `${user ? "ユーザー（User）" : "取引先（Account）"}の件数は **${aggregate.value.toLocaleString("ja-JP")} ${user ? "名" : "件"}**です。\n\n${summaryText(summary)}${fields}${body.context_applied?.applied ? "\n直前の検索対象・担当範囲・条件を引き継ぎ、今回の条件を追加しました。" : ""}`;
  }
  return undefined;
}

export function salesforceReadMetadata(body: any) {
  return { zero_reason: body.zero_reason, account_candidates: body.account_candidates,
    field_candidates: body.field_candidates, truncated: body.truncated, aggregation_result: body.aggregation_result,
    resolved_fields: body.resolved_fields, context_applied: body.context_applied, total_count: body.total_count,
    total_count_source: body.total_count_source, applied_owner_scope: body.applied_owner_scope, error_kind: body.error_kind };
}
