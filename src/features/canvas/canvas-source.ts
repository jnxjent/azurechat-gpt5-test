import "server-only";
import { randomUUID } from "node:crypto";
import { personalSalesforceBase, signSalesforceRequest, assertPersonalSalesforceResponse } from "@/features/common/services/salesforce-personal";
import { validateCanvas, type CanvasDocument } from "./canvas-rules";
type CanvasShareUser = { principal: string; email: string };
export type Source = { provider: "salesforce"; query: string; thread: string; proof: string; proofs?:string[]; savedCanvas?:{threadId:string;version:number} };
export class CanvasSourceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function gateway(user: CanvasShareUser, path: string, thread: string, body?: string, query?: string) {
  if (process.env.SF_PERSONAL_AUTH_METHOD !== "oauth" || process.env.SF_PERSONAL_SNAPSHOT_POLICY !== "strict") throw new CanvasSourceError(503, "本人接続の設定を確認してください。");
  const url = new URL(path, personalSalesforceBase());
  if (url.protocol !== "https:" || !["/api/sf/query_nl", "/api/sf/revalidate_shared"].includes(path)) throw new CanvasSourceError(503, "本人接続の接続先を確認してください。");
  if (query) { url.searchParams.set("q", query); url.searchParams.set("mode", "real"); }
  const method = body === undefined ? "GET" : "POST";
  const headers = signSalesforceRequest({ ...user, thread, url, method, body }, process.env.SF_PERSONAL_SIGNING_KEY ?? "");
  const response = await fetch(url, { method, body, headers: { ...headers, "X-User-Email": user.email, "X-Chat-Thread-Id": thread, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new CanvasSourceError(403, "現在のSalesforce権限または本人接続を確認できません。");
  assertPersonalSalesforceResponse(response, headers);
  return response.json();
}
const cell = (v: unknown) => String(v ?? "未取得").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");
async function retrieveSalesforce(user: CanvasShareUser, query: string): Promise<{ document: CanvasDocument; source: Source }> {
  if (!query.trim() || query.length > 1000) throw new CanvasSourceError(400, "取得したい内容を1〜1000文字で指定してください。");
  const thread = `shared-${randomUUID()}`;
  const data = await gateway(user, "/api/sf/query_nl", thread, undefined, query);
  if (data.ok !== true || typeof data.snapshot_proof !== "string" || !data.snapshot_proof || !Array.isArray(data.items)) throw new CanvasSourceError(422, "この結果は元データの閲覧権限を再確認できないため共有できません。まず一覧検索で試してください。");
  const rows = data.items.slice(0, 20).filter((item: unknown) => item && typeof item === "object").map((item: Record<string, unknown>) => Object.fromEntries(Object.entries(item).filter(([k, v]) => !k.startsWith("_") && k !== "attributes" && (v === null || ["string", "number", "boolean"].includes(typeof v)))));
  const columns = Array.from(new Set<string>(rows.flatMap((row: Record<string, unknown>) => Object.keys(row))));
  const content = columns.length ? [`| ${columns.map(cell).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((row: Record<string, unknown>) => `| ${columns.map(k => cell(row[k])).join(" | ")} |`)].join("\n") : "対象データはありません。";
  const document = validateCanvas({ threadId: thread, title: "Salesforceレポート", content: `表示：${rows.length}件（最大20件）\n\n${content}`, unit: "", period: "", source: "Salesforce FullSand", chartType: "bar", tableIndex: 0, valueColumn: 1, version: 1 });
  return { document, source: { provider: "salesforce", query, thread, proof: data.snapshot_proof } };
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
export async function retrieveCanvasSource(user: CanvasShareUser, request: { provider: Source["provider"]; query: string }) {
  const provider = providers[request.provider];
  if (!provider) throw new CanvasSourceError(422, "このデータ出典はまだ共有に対応していません。");
  return provider.retrieve(user, request.query);
}
export async function revalidateCanvasSource(source: Source, user: CanvasShareUser) {
  const provider = providers[source.provider];
  return provider ? provider.revalidate(source, user) : false;
}
