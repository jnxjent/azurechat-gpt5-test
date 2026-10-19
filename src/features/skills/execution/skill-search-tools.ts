import "server-only";
import { isSalesforceAllowedEmail } from "@/features/common/services/salesforce-access";
import { buildSalesforceGatewayQuery } from "@/features/common/services/salesforce-routing";
import { ExtensionSimilaritySearch } from "@/features/chat-page/chat-services/azure-ai-search/azure-ai-search";
import { resolveUserContext } from "@/features/chat-page/chat-services/chat-api/chat-api-rag";
import { CreateCitations, FormatCitations } from "@/features/chat-page/chat-services/citation-service";
import { searchBraveWeb, isTeamsBraveSearchConfigured } from "@/features/teams/teams-brave-search-service";
import { buildSlSearchTargetFilter, inferSlSearchTarget, stripSlSearchTargetTerms } from "@/lib/sl-search-target";
import { SKILL_SEARCH_LIMITS, boundSearchResult, validateSearchQuery } from "./skill-search-policy";
import type { SearchSource, SkillSearchResult } from "./skill-search-policy";
import { formatCitationMarkup } from "@/features/ui/markdown/citation-markup";
import { buildAccountCandidateQuery, companyForLookup, hasInvalidCompanyFilter, isCompanyLookup, matchesCompanyName, sameSalesforceId, withSalesforceRecordId } from "./salesforce-search-query";
import type { SelectedSearchAccount } from "./skill-search-continuation";
import type { FiscalPeriod } from "./skill-search-requirements";

export function createSkillSearchTools(props: { email: string; threadId: string; signal: AbortSignal; userMessage: string; selectedAccount?: SelectedSearchAccount; selectedAccountRecord?: Record<string, unknown>; fiscalPeriod?: FiscalPeriod }) {
  let calls = 0;
  const citationResults: string[] = [];
  const contextResults: string[] = [];
  const trace: Array<{ source: SearchSource; status: string; truncated?: boolean }> = [];
  async function execute(source: SearchSource, input: unknown, companyName?: unknown, operation?: unknown): Promise<SkillSearchResult> {
    const started = Date.now();
    let result: SkillSearchResult;
    try {
      if (props.signal.aborted) throw new Error("aborted");
      if (++calls > SKILL_SEARCH_LIMITS.calls) result = { source, status: "limit", message: "検索回数上限です。取得済みの結果で回答してください。" };
      else {
        const query = validateSearchQuery(input);
        // Existing document/Web clients do not all accept AbortSignal. Bound our wait
        // as well, while passing the signal to clients that support cancellation.
        result = await new Promise<SkillSearchResult>((resolve, reject) => {
          const aborted = () => { clearTimeout(timeout); reject(new Error("aborted")); };
          const timeout = setTimeout(() => { props.signal.removeEventListener("abort", aborted); reject(new Error("timeout")); }, 25_000);
          props.signal.addEventListener("abort", aborted, { once: true });
          search(source, query, companyName, operation).then(resolve, reject).finally(() => { clearTimeout(timeout); props.signal.removeEventListener("abort", aborted); });
        });
      }
    } catch (error) {
      result = { source, status: "error", reason: props.signal.aborted ? "cancelled" : error instanceof TypeError ? "invalid_input_or_connection" : error instanceof Error && error.message === "timeout" ? "timeout" : "connection_failed", message: "検索を完了できませんでした。接続失敗・タイムアウト等のため、データの有無は判断できません。" };
    }
    result = boundSearchResult(result);
    if (source === "documents" && Array.isArray(result.data)) {
      const markup = formatCitationMarkup(result.data);
      if (markup) citationResults.push(markup);
    }
    trace.push({ source, status: result.status, ...(result.truncated ? { truncated: true } : {}) });
    console.info("[skill-search] result", { source, gateway: result.reason === "selected_account_snapshot" ? "snapshot" : source === "salesforce" ? process.env.SF_SKILL_READ_BASE_URL ? "typed_local" : "legacy_nl" : source, status: result.status, reason: result.reason ?? result.status, httpStatus: result.httpStatus ?? null, elapsedMs: Date.now() - started, returnedCount: Array.isArray(result.data) ? result.data.length : null, excludedCount: result.excludedCount ?? 0, truncated: Boolean(result.truncated) });
    return result;
  }
  async function search(source: SearchSource, query: string, suppliedCompany?: unknown, suppliedOperation?: unknown): Promise<SkillSearchResult> {
    if (source === "salesforce") {
      if (!isSalesforceAllowedEmail(props.email)) return { source, status: "denied", reason: "sf_whitelist_denied", message: "Salesforce参照権限がありません。" };
      if (props.selectedAccount && sameSalesforceId(props.selectedAccountRecord?.Id, props.selectedAccount.id) && (!suppliedOperation || suppliedOperation === "accounts") && isCompanyLookup(query)) {
        return { source, status: "ok", reason: "selected_account_snapshot", data: [props.selectedAccountRecord], message: "利用者が直前の検索結果から選んだAccountの取得済みデータです（候補提示時点のスナップショット）。同名の別Accountを混ぜず、このレコードの値を使用してください。" };
      }
      const typedBase = process.env.SF_SKILL_READ_BASE_URL;
      if (suppliedOperation === "sales" && !typedBase) return { source, status: "unavailable", reason: "typed_sales_required", message: "売上の請求先照合と年度集計には構造化読み取りGatewayが必要です。従来の自然言語検索では代替しません。" };
      const base = typedBase || process.env.SF_GATEWAY_BASE_URL;
      if (!base) return { source, status: "unavailable", reason: "gateway_not_configured", message: "Salesforce Gateway未設定です。" };
      if (typedBase && !process.env.SF_SKILL_READ_KEY) return { source, status: "unavailable", reason: "gateway_key_missing" };
      const url = new URL(typedBase ? "/api/skills/salesforce/search" : "/api/sf/query_nl", base);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
        return { source, status: "unavailable", reason: "invalid_gateway_url", message: "Gatewayの接続設定を確認してください。" };
      }
      url.searchParams.set("engine", "auto"); url.searchParams.set("mode", "real");
      const request = (text: string) => {
        const target = new URL(url);
        if (typedBase) {
          if (!process.env.SF_SKILL_READ_KEY) throw new Error("Skill read key missing");
          const company = companyForLookup(props.userMessage, suppliedCompany);
          let operation = ["accounts", "opportunities", "activities", "sales"].includes(String(suppliedOperation)) ? String(suppliedOperation) : /商談|Opportunity/i.test(text) ? "opportunities" : /活動履歴|活動一覧|Task|Event/i.test(text) ? "activities" : /Sales__c|売上|受注合計/i.test(text) ? "sales" : "accounts";
          if (company && !props.selectedAccount) operation = "accounts";
          return fetch(target, { method: "POST", signal: props.signal, headers: { "Content-Type": "application/json", "X-User-Email": props.email, "X-Skill-Read-Key": process.env.SF_SKILL_READ_KEY }, body: JSON.stringify({ operation, ...(company ? { company } : {}), ...(props.selectedAccount ? { accountId: props.selectedAccount.id } : {}), ...(operation === "sales" ? props.fiscalPeriod : {}) }) });
        }
        target.searchParams.set("q", buildSalesforceGatewayQuery(text));
        return fetch(target, { signal: props.signal, headers: { "X-User-Email": props.email, "X-Chat-Thread-Id": props.threadId } });
      };
      const response = await request(query);
      if (!response.ok) {
        let reason = "gateway_http_error";
        try { const error = (await response.json()).error; if (["local_connection_required", "identity_mismatch", "sandbox_required", "salesforce_denied", "salesforce_query_failed", "activities_unavailable", "local_read_unavailable", "account_required", "unsupported_operation", "unauthorized", "user_denied"].includes(error)) reason = error; } catch { /* Do not log upstream bodies. */ }
        return { source, status: response.status === 401 || response.status === 403 ? "denied" : "error", reason, httpStatus: response.status };
      }
      let body;
      try { body = await response.json(); } catch { return { source, status: "error", reason: "invalid_json_response" }; }
      if (body.ok === false || body.error) return { source, status: "error", reason: "gateway_result_error", message: "Gatewayが検索を完了できませんでした。未対応条件の可能性もあるため0件とは扱わないでください。" };
      if (!Array.isArray(body.items)) return { source, status: "error", reason: "invalid_gateway_response", message: "Gatewayの検索結果形式を確認できませんでした。" };
      const company = companyForLookup(props.userMessage, suppliedCompany);
      if (typedBase && suppliedOperation === "sales" && body.object !== "SalesSummary") return { source, status: "error", reason: "unexpected_object", message: "売上集計に対して異なるオブジェクトが返りました。売上結果として使用しないでください。" };
      const invalidFilter = hasInvalidCompanyFilter(body.soql);
      const wrongObject = company && isCompanyLookup(query) && body.object && body.object !== "Account";
      const lookup = company && (isCompanyLookup(query) || body.object === "Account");
      const canRecover = lookup && !/私の|自分の|部下|所有|期間|以降|以前|集計|件数|合計|以上|以下|年度/.test(query);
      if (!typedBase && canRecover && (invalidFilter || wrongObject || (body.object === "Account" && !body.items.length))) {
        if (calls >= SKILL_SEARCH_LIMITS.calls) return { source, status: "limit", message: "取引先検索を確認するための追加検索枠がありません。0件とは断定できません。" };
        calls++;
        const fallback = await request(buildAccountCandidateQuery(company));
        if (fallback.status === 401 || fallback.status === 403) return { source, status: "denied", reason: "recovery_denied", httpStatus: fallback.status };
        if (!fallback.ok) return { source, status: "error", reason: "recovery_http_error", httpStatus: fallback.status, message: "会社名を明示した候補検索に失敗しました。" };
        body = await fallback.json();
        if (body.ok === false || body.error || !Array.isArray(body.items) || hasInvalidCompanyFilter(body.soql) || body.object !== "Account") {
          return { source, status: "error", reason: "invalid_company_filter_or_object", message: "Gatewayが会社名を正しい取引先検索条件へ変換できませんでした。正常な0件結果ではありません。" };
        }
      } else if (invalidFilter) {
        return { source, status: "error", reason: "invalid_company_filter", message: "Gatewayの会社名検索条件が不正です。会社が見つからないという意味ではありません。" };
      } else if (!typedBase && wrongObject) {
        return { source, status: "error", reason: "unexpected_object", message: "取引先検索で別のオブジェクトが返りました。正常な取引先0件という結果ではありません。" };
      }
      body.items = body.items.map((item: Record<string, unknown>) => withSalesforceRecordId(item, body.object));
      console.info("[skill-search] salesforce", { object: body.object ?? "unknown", returnedCount: body.items.length, totalCount: body.total_count ?? null, recoveredInvalidFilter: invalidFilter });
      let excludedCount = 0;
      if (lookup && body.object === "Account") {
        const matching = body.items.filter((item: Record<string, unknown>) => matchesCompanyName(item.Name, company));
        excludedCount += body.items.length - matching.length;
        if (excludedCount && !matching.length) return { source, status: "error", reason: "company_mismatch", excludedCount, message: "対象会社名に一致する取引先を検証できませんでした。正常な0件とは扱わないでください。" };
        body.items = matching;
      }
      if (props.selectedAccount && body.object === "Account") {
        body.items = body.items.filter((item: Record<string, unknown>) => sameSalesforceId(item.Id, props.selectedAccount!.id));
        if (!body.items.length) return { source, status: "error", reason: "selected_account_not_returned", message: "選択したAccount IDと一致するレコードを取得できませんでした。別の取引先で代用しないでください。" };
        body.total_count = body.items.length;
      }
      if (props.selectedAccount && ["Opportunity", "Activity", "SalesSummary"].includes(body.object)) {
        const matching = body.items.filter((item: Record<string, unknown>) => sameSalesforceId(body.object === "SalesSummary" ? item.Billing__c : item.AccountId, props.selectedAccount!.id));
        const excluded = body.items.length - matching.length;
        excludedCount += excluded;
        if (excluded && !matching.length) return { source, status: "error", reason: "account_id_unverified", excludedCount, message: "対象Accountとの一致を検証できる商談がありません。除外後の空を商談0件と扱わないでください。" };
        body.items = matching;
        body.total_count = null;
      }
      if (excludedCount) { body.total_count = null; body.truncated = true; }
      if (lookup && body.object === "Account" && (body.items.length > 1 || Number(body.total_count) > 1)) {
        const snapshot = { integration: "skill_search_account_candidates", observedAt: new Date().toISOString(), records: [...body.items], message: "対象取引先の候補を確認してください。" };
        while (snapshot.records.length && Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 15_000) snapshot.records.pop();
        if (!snapshot.records.length) return { source, status: "limit", message: "取引先候補が大きすぎます。会社名を絞ってください。" };
        contextResults.push(JSON.stringify(snapshot));
        return { source, status: "needs_confirmation", truncated: Boolean(body.truncated) || snapshot.records.length < body.items.length, data: snapshot.records.map((item: Record<string, unknown>) => ({ Id: item.Id, Name: item.Name, lightning_url: item.lightning_url, BillingPostalCode: item.BillingPostalCode, BillingCountry: item.BillingCountry, BillingState: item.BillingState, BillingCity: item.BillingCity, BillingStreet: item.BillingStreet, OwnerName: item.OwnerName })), message: `会社名に対応する取引先候補が複数あります（総件数 ${body.total_count ?? body.items.length}、候補提示 ${snapshot.records.length}）。この候補は0件ではありません。候補の名前とIDを示し、対象の取引先を利用者に確認してください。別工場・部署の商談を勝手に混ぜないでください。` };
      }
      return { source, status: body.items.length ? "ok" : "empty", reason: excludedCount ? "partial_verified_results" : "query_completed", queryCount: typeof body.query_count === "number" ? body.query_count : undefined, excludedCount, data: body.items, ...(body.truncated ? { truncated: true } : {}), message: JSON.stringify({ object: body.object ?? "不明", contract: body.contract, notices: body.notices, appliedFilters: body.applied_filters, order: body.order, limits: body.limits, displayHint: body.display_hint ?? "不明", resolvedAccountName: body.resolved_account_name ?? null, returnedCount: body.items.length, totalCount: body.total_count ?? null, excludedCount, guidance: "一致を検証できない行を除外している場合は除外件数を明示する。OwnerNameは社内の担当営業。上限取得や除外後の一部を全件集計に使わない。指定期間等が実際の適用条件にない場合はその制限も明示する。" }) };
    }
    if (source === "web") {
      if (!isTeamsBraveSearchConfigured()) return { source, status: "unavailable", message: "Web検索未設定です。" };
      try {
        const result = await searchBraveWeb({ query, startIndex: 1 });
        return { source, status: result.sources.length ? "ok" : "empty", data: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/SUBSCRIPTION_TOKEN_INVALID|HTTP (?:401|403)/.test(message)) return { source, status: "denied", reason: "web_authentication_failed", message: "公開Web検索サービスの認証に失敗しました。検索キーの確認が必要です。Web情報の有無は判断できません。取得済みのSalesforce情報は使用し、ブリーフィングの作成を続けてください。" };
        if (/HTTP 429/.test(message)) return { source, status: "error", reason: "web_rate_limited", message: "公開Web検索サービスの利用制限に達しました。取得済みのSalesforce情報を使用して回答してください。" };
        throw error;
      }
    }
    const apiKey = process.env.AZURE_SEARCH_API_KEY, searchName = process.env.AZURE_SEARCH_NAME, indexName = process.env.AZURE_SEARCH_INDEX_NAME;
    if (!apiKey || !searchName || !indexName) return { source, status: "unavailable", message: "社内資料検索未設定です。" };
    const context = await resolveUserContext();
    if (!context.email || context.email.toLowerCase() !== props.email.toLowerCase() || !context.userHash || !context.deptLower) return { source, status: "denied", message: "社内資料の本人・部署権限を確認できませんでした。" };
    const requested = inferSlSearchTarget(props.userMessage);
    const target = requested.folderUncertain ? requested : { ...inferSlSearchTarget(query), ...Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== undefined && value !== false && value !== "all")) };
    if (target.folderUncertain) return { source, status: "needs_confirmation", message: "検索するフォルダー名を確認してください。" };
    const scope = buildSlSearchTargetFilter(target);
    const baseFilter = `(chatThreadId eq '${props.threadId.replace(/'/g, "''")}' or isSlDoc eq true)`;
    const result = await ExtensionSimilaritySearch({ searchText: stripSlSearchTargetTerms(query, target), vectors: ["embedding"], apiKey, searchName, indexName, filter: scope ? `(${baseFilter}) and (${scope})` : baseFilter, deptLower: context.deptLower, userHash: context.userHash, top: 6 });
    if (result.status !== "OK") return { source, status: "error" };
    const citations = await CreateCitations(FormatCitations(result.response));
    const data = citations.flatMap(item => item.status === "OK" ? [{ id: item.response.id, name: item.response.content.document.metadata, content: item.response.content.document.pageContent.slice(0, 2400) }] : []);
    if (result.response.length && !data.length) return { source, status: "error", message: "参照元の保存に失敗しました。" };
    return { source, status: data.length ? "ok" : "empty", data, message: "検索に一致した資料の抜粋です。文書全体・全件を読んだ結果ではありません。" };
  }
  return { execute, trace, citationResults, contextResults };
}
