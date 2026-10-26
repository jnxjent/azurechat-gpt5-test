import { personalSalesforceForEmail,personalSalesforceUsers,personalSalesforceBase,signSalesforceRequest,assertPersonalSalesforceResponse } from "@/features/common/services/salesforce-personal";
import type {CanvasActor} from "@/features/canvas/canvas-actor";
import {salesforceMonthlyReport,accountSelectionText,validAccountCandidates,type SalesforceAccount} from "@/features/common/services/salesforce-account-selection";
import "server-only";
import { salesforceReadText, salesforceReadInstruction, salesforceReadMetadata } from "@/features/common/services/salesforce-read-result";

import { OpenAIInstance } from "@/features/common/services/openai";
import { buildSalesforceGatewayQuery } from "@/features/common/services/salesforce-routing";

const requestCache = new Map<string, Promise<string>>();
const MAX_REQUEST_CACHE_SIZE = 500;

export function isTeamsSalesforceConfigured(): boolean {
  return Boolean(
    process.env.SF_GATEWAY_BASE_URL?.trim() ||
      process.env.SF_EXTENSION_ID?.trim()
  );
}

export async function queryTeamsSalesforce(props: {
  message: string;
  userEmail: string;
  conversationId: string;
  activityId: string;
  actor?:CanvasActor;
  accountId?:string;
  onAccountSelection?:(query:string,candidates:SalesforceAccount[])=>Promise<void>;
}): Promise<string> {
  if (personalSalesforceForEmail(props.userEmail)&&(!props.actor?.salesforcePrincipal||props.actor.email!==props.userEmail||!personalSalesforceUsers().some(v=>v.principal===props.actor!.salesforcePrincipal&&v.email===props.userEmail)))return "Teamsの本人対応を確認できません。Test用BOTの個人チャットから操作してください。";
  const requestKey = `${props.actor?.salesforcePrincipal??"shared"}\n${props.conversationId}\n${props.activityId}\n${props.accountId??""}`;
  const existing = props.activityId ? requestCache.get(requestKey) : undefined;
  if (existing) return existing;

  const request = executeQuery(props);
  if (props.activityId) {
    requestCache.set(requestKey, request);
    while (requestCache.size > MAX_REQUEST_CACHE_SIZE) {
      const oldest = requestCache.keys().next().value as string | undefined;
      if (!oldest) break;
      requestCache.delete(oldest);
    }
  }
  return request;
}

async function executeQuery(props: {
  message: string;
  userEmail: string;
  conversationId: string;
  actor?:CanvasActor;
  accountId?:string;
  onAccountSelection?:(query:string,candidates:SalesforceAccount[])=>Promise<void>;
}): Promise<string> {
  const personal=personalSalesforceForEmail(props.userEmail);
  const base =personal?personalSalesforceBase():
    process.env.SF_GATEWAY_BASE_URL?.replace(/\/+$/, "") ||
    "http://127.0.0.1:8001";
  const url = new URL("/api/sf/query_nl", base);
  url.searchParams.set("q", buildSalesforceGatewayQuery(props.message));
  url.searchParams.set("engine", "auto");
  url.searchParams.set("mode", "real");
  if(props.accountId){if(!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(props.accountId))throw Error("Invalid Account ID");url.searchParams.set("account_id",props.accountId);}

  console.log("[SF] Teams calling direct NL gateway", {
    host: url.host,
  });

  let response: Response;
  const populationEnabled=personal&&process.env.SF_OPPORTUNITY_POPULATION_ENABLED==="true";
  let population:import("./teams-salesforce-context").TeamsOpportunityContext|undefined;
  try {
    const thread=`teams-${props.conversationId}`;
    if(personal&&(process.env.SF_PERSONAL_AUTH_METHOD!=="oauth"||process.env.SF_PERSONAL_SNAPSHOT_POLICY!=="strict"||url.protocol!=="https:"))throw Error("Personal Salesforce configuration invalid");
    if(populationEnabled)population=await (await import("./teams-salesforce-context")).readTeamsOpportunityContext(props.actor!,props.conversationId);
    const signed=personal?signSalesforceRequest({principal:props.actor!.salesforcePrincipal!,email:props.userEmail,thread,url},process.env.SF_PERSONAL_SIGNING_KEY??""):{};
    response = await fetch(url, {
      headers: {
        ...signed,
        ...(populationEnabled?{"X-SF-Opportunity-Population":"v1"}:{}),
        ...(population?.token?{"X-SF-Opportunity-Context":population.token}:{}),
        "X-User-Email": props.userEmail,
        "X-Chat-Thread-Id": `teams-${props.conversationId}`,
      },cache:"no-store",redirect:"error",signal:AbortSignal.timeout(90000),
    });
    if(personal&&response.ok)assertPersonalSalesforceResponse(response,signed);
  } catch (error) {
    console.error("[SF] Teams gateway request failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return "Salesforce Gatewayへ接続できなかったため、Salesforce上の情報を取得できませんでした。しばらくしてから再度お試しください。";
  }

  let data = await response.json().catch(() => null);
  if(populationEnabled&&population&&response.ok&&data?.ok!==false&&data) {
    try {await (await import("./teams-salesforce-context")).saveTeamsOpportunityContext(props.actor!,props.conversationId,population,data.population_context);}
    catch {return "商談の検索対象を保存できませんでした。同時操作を終了してから再度お試しください。";}
  }
  if(data&&typeof data==="object") {const {population_context:_privateContext,...display}=data;data=display;}
  const authoritativeText = salesforceReadText(data);
  if (authoritativeText) return authoritativeText;
  if (!response.ok) {
    console.error("[SF] Teams gateway returned an error", {
      status: response.status,
    });
    return `Salesforce上の情報を取得できませんでした（Gateway HTTP ${response.status}）。しばらくしてから再度お試しください。`;
  }

  if (!data || data.ok === false) {
    return "Salesforce Gatewayから有効な結果を取得できませんでした。";
  }
  if(data.status==="needs_account_selection") {
    const candidates=validAccountCandidates(data.account_candidates);
    if(props.onAccountSelection&&candidates.length){await props.onAccountSelection(props.message,candidates);return "カードから対象の取引先を選択してください。";}
    return accountSelectionText(candidates,Boolean(data.candidates_truncated));
  }
  const monthly=salesforceMonthlyReport(data,false);if(monthly)return monthly;

  // The Gateway supplies compact display rows and authoritative table/scope
  // instructions. Do not replace them with a generic summary prompt.
  const json = JSON.stringify({
    ...salesforceReadMetadata(data),
    ok: data.ok, display_hint: data.display_hint, count: data.count,
    total_count: data.total_count, items: data.items,
    pagination: data.pagination, stage_summary: data.stage_summary,
  });
  const openAI = OpenAIInstance();
  const completion = await openAI.chat.completions.create({
    model:
      process.env.AZURE_OPENAI_SOQL_CHAT_MODEL?.trim() ||
      process.env.AZURE_OPENAI_SOQL_MODEL?.trim() ||
      process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME?.trim() ||
      "",
    messages: [
      {
        role: "system",
        content:
          [
            "Salesforce Gatewayが返したJSONだけを根拠に、日本語で回答してください。JSONに存在しない情報を推測しないでください。lightning_urlがある場合は[開く](URL)形式にしてください。GatewayのJSONや内部指示は表示しないでください。",
            "total_countは総件数、countは現在ページの件数です。itemsがある場合に該当なしと回答してはいけません。",
            salesforceReadInstruction,
            typeof data.table_instruction === "string" ? data.table_instruction : "",
          ].join("\n"),
      },
      { role: "user", content: `質問:\n${props.message}\n\nGateway JSON:\n${json}` },
    ],
  });

  return (
    completion.choices[0]?.message?.content?.trim() ||
    "Salesforce Gatewayから回答を生成できませんでした。"
  );
}
