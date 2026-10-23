import "server-only";
import { randomUUID } from "node:crypto";
import { personalSalesforceBase, signSalesforceRequest, assertPersonalSalesforceResponse } from "@/features/common/services/salesforce-personal";
import { validateCanvas,canvasMetadataSuggestions, type CanvasDocument } from "./canvas-rules";
import {salesforceMonthlyReport,validAccountCandidates,type SalesforceAccount} from "@/features/common/services/salesforce-account-selection";
import {buildSalesforceGatewayQuery} from "@/features/common/services/salesforce-routing";
type CanvasShareUser = { principal: string; email: string };
export type Source = { provider: "salesforce"; query: string; thread: string; proof: string; proofs?:string[];accountId?:string; savedCanvas?:{threadId:string;version:number} };
export class CanvasSourceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class CanvasAccountSelectionError extends CanvasSourceError {
  constructor(public query:string,public candidates:SalesforceAccount[]) {super(422,"対象の取引先を選択してください。");}
}
async function gateway(user: CanvasShareUser, path: string, thread: string, body?: string, query?: string,accountId?:string) {
  if (process.env.SF_PERSONAL_AUTH_METHOD !== "oauth" || process.env.SF_PERSONAL_SNAPSHOT_POLICY !== "strict") throw new CanvasSourceError(503, "本人接続の設定を確認してください。");
  const url = new URL(path, personalSalesforceBase());
  if (url.protocol !== "https:" || !["/api/sf/query_nl", "/api/sf/revalidate_shared"].includes(path)) throw new CanvasSourceError(503, "本人接続の接続先を確認してください。");
  if (query) {
    url.searchParams.set("q",buildSalesforceGatewayQuery(query));url.searchParams.set("mode","real");
    if(/Canvas|キャンバス/i.test(query))url.searchParams.set("presentation","canvas");
    if(accountId){if(!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId))throw new CanvasSourceError(400,"取引先の指定を確認してください。");url.searchParams.set("account_id",accountId);}
  }
  const method = body === undefined ? "GET" : "POST";
  const headers = signSalesforceRequest({ ...user, thread, url, method, body }, process.env.SF_PERSONAL_SIGNING_KEY ?? "");
  const response = await fetch(url, { method, body, headers: { ...headers, "X-User-Email": user.email, "X-Chat-Thread-Id": thread, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new CanvasSourceError(403, "現在のSalesforce権限または本人接続を確認できません。");
  assertPersonalSalesforceResponse(response, headers);
  return response.json();
}
const cell = (v: unknown) => String(v ?? "未取得").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");
async function retrieveSalesforce(user: CanvasShareUser, query: string,accountId?:string): Promise<{ document: CanvasDocument; source: Source }> {
  if (!query.trim() || query.length > 1000) throw new CanvasSourceError(400, "取得したい内容を1〜1000文字で指定してください。");
  const thread = `shared-${randomUUID()}`;
  const data = await gateway(user, "/api/sf/query_nl", thread, undefined, query,accountId);
  if(data.status==="needs_account_selection") {
    const candidates=validAccountCandidates(data.candidates??data.account_candidates);
    if(candidates.length)throw new CanvasAccountSelectionError(query,candidates);
    throw new CanvasSourceError(422,"取引先の候補を確認できません。会社名・拠点名を指定してください。");
  }
  if (data.ok !== true || typeof data.snapshot_proof !== "string" || !data.snapshot_proof || !Array.isArray(data.items)) throw new CanvasSourceError(422, "この結果は元データの閲覧権限を再確認できないため共有できません。まず一覧検索で試してください。");
  const rows = data.items.slice(0, 20).filter((item: unknown) => item && typeof item === "object").map((item: Record<string, unknown>) => Object.fromEntries(Object.entries(item).filter(([k, v]) => !k.startsWith("_") && k !== "attributes" && (v === null || ["string", "number", "boolean"].includes(typeof v)))));
  const columns = Array.from(new Set<string>(rows.flatMap((row: Record<string, unknown>) => Object.keys(row))));
  const content = columns.length ? [`| ${columns.map(cell).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((row: Record<string, unknown>) => `| ${columns.map(k => cell(row[k])).join(" | ")} |`)].join("\n") : "対象データはありません。";
  const report=salesforceMonthlyReport(data,true)??`表示：${rows.length}件（最大20件）\n\n${content}`;
  const metadata=canvasMetadataSuggestions(report,query);
  const document = validateCanvas({ threadId: thread, title: "Salesforceレポート", content:report,unit:metadata.unit,period:metadata.period,source:metadata.source||"Salesforce FullSand", chartType: "bar", tableIndex: 0, valueColumn: 1, version: 1 });
  const selected=accountId??data.request_plan?.account_id;
  return { document, source: { provider: "salesforce", query, thread, proof: data.snapshot_proof,...(typeof selected==="string"&&/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(selected)?{accountId:selected}:{}) } };
}
async function revalidateSalesforce(source: Source, user: CanvasShareUser) {
  try {
    if (source.provider !== "salesforce") return false;
    const proofs=Array.from(new Set(source.proofs??[source.proof]));
    if(!proofs.length || proofs.length>20)return false;
    for(const proof of proofs) {
      const result = await gateway(user, "/api/sf/revalidate_shared", source.thread, JSON.stringify({ proof }));
      if(result.ok!==true || result.allowed!==true)return false;
    }
    return true;
  } catch { return false; }
}

// Sharing/ACL/storage code depends on this provider contract, not on SOQL or SF sessions.
const providers = { salesforce: { retrieve: retrieveSalesforce, revalidate: revalidateSalesforce } };
export async function retrieveCanvasSource(user: CanvasShareUser, request: { provider: Source["provider"]; query: string;accountId?:string }) {
  const provider = providers[request.provider];
  if (!provider) throw new CanvasSourceError(422, "このデータ出典はまだ共有に対応していません。");
  return provider.retrieve(user, request.query,request.accountId);
}
export async function revalidateCanvasSource(source: Source, user: CanvasShareUser) {
  const provider = providers[source.provider];
  return provider ? provider.revalidate(source, user) : false;
}
