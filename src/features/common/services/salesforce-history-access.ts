import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { salesforcePersonalHeaders, assertPersonalSalesforceResponse, personalSalesforceEnabled } from "./salesforce-personal";
import type { ChatMessageModel } from "@/features/chat-page/chat-services/models";
import { validateCanvas, type CanvasDocument } from "@/features/canvas/canvas-rules";
import { readFileSync } from "node:fs";
import { isPersonalSalesforceUser, personalSalesforceBase } from "./salesforce-personal";

export const RESTRICTED_HISTORY = "現在のSalesforce権限で再検証できないため、この保存済み回答は表示していません。必要なデータを改めて検索してください。";
export type HistoryAccess = { v: 1; owner: string; thread: string; role: string; hash: string; sf: boolean; proof: string | null; dependencies?: string[]; signature: string };

function digest(content: string) { return createHash("sha256").update(content).digest("hex"); }
function signature(domain: string, value: unknown) {
  const key = process.env.SF_PERSONAL_SIGNING_KEY ?? "";
  if (key.length < 32) throw Error("history_verification_unavailable");
  return createHmac("sha256", key).update(domain + JSON.stringify(value)).digest("hex");
}
function equal(a: string, b: string) {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function accessValue(access: HistoryAccess) {
  return { v: access.v, owner: access.owner, thread: access.thread, role: access.role, hash: access.hash, sf: access.sf, proof: access.proof, ...(access.dependencies ? { dependencies: access.dependencies } : {}) };
}
export function sealHistoryMessage(message: ChatMessageModel): HistoryAccess | undefined {
  if (!personalSalesforceEnabled() || message.role === "user") return undefined;
  const value = { v: 1 as const, owner: message.userId, thread: message.threadId, role: message.role,
    hash: digest(JSON.stringify({ content: message.content, image: message.multiModalImage ?? "", name: message.name })),
    sf: Boolean(message.salesforceSnapshot), proof: message.salesforceSnapshot?.proof ?? null,
    ...(message.salesforceSnapshot?.proofs ? { dependencies: message.salesforceSnapshot.proofs } : {}) };
  return { ...value, signature: signature("history-v1:", value) };
}
function validAccess(access: HistoryAccess | undefined, owner: string, thread: string, role: string) {
  if (!access || access.v !== 1 || access.owner !== owner || access.thread !== thread || access.role !== role) return false;
  return equal(access.signature, signature("history-v1:", accessValue(access)));
}

function legacyIndex(): Record<string, { origin: "sf" | "non_sf"; hash: string; thread: string }> {
  try { return JSON.parse(readFileSync(process.env.SF_PERSONAL_LEGACY_INDEX_PATH ?? "", "utf8")); } catch { return {}; }
}
export function legacyOrigin(item: { id: string; content: string; threadId: string }, owner: string) {
  const row = legacyIndex()[`${owner}/${item.id}`];
  return row?.thread === item.threadId && row.hash === digest(item.content) ? row.origin : "unknown";
}

export function sealNonSalesforceCitation(item: {id:string;content:unknown;userId:string}) {
  return signature("non-sf-citation-v1:",{id:item.id,content:item.content,userId:item.userId});
}
export function validNonSalesforceCitation(item: {id:string;content:unknown;userId:string;nonSalesforceSeal?:string}) {
  try { return Boolean(item.nonSalesforceSeal && equal(item.nonSalesforceSeal,sealNonSalesforceCitation({id:item.id,content:item.content,userId:item.userId}))); } catch { return false; }
}

/** No cross-request permission cache. Deduplicate only the proofs in this operation. */
async function checkProofs(proofs: string[], thread: string) {
  try {
    const distinct = Array.from(new Set(proofs));
    if (!distinct.length || distinct.length > 20) return false;
    const user = await getCurrentUser();
    const base = personalSalesforceBase();
    for (const proof of distinct) {
      const url = new URL("/api/sf/revalidate", base), body = JSON.stringify({ proof });
      const headers = await salesforcePersonalHeaders(url, user.email, thread, "POST", body);
      const response = await fetch(url, { method: "POST", body, headers: { ...headers, "Content-Type": "application/json", "X-User-Email": user.email.trim().toLowerCase(), "X-Chat-Thread-Id": thread }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!response.ok) return false;
      assertPersonalSalesforceResponse(response, headers);
      const result = await response.json();
      if (result.ok !== true || result.allowed !== true) return false;
    }
    return true;
  } catch { return false; }
}

export async function sourceMessages(thread: string, owner: string): Promise<ChatMessageModel[]> {
  const { resources } = await HistoryContainer().items.query<ChatMessageModel>({
    query: "SELECT * FROM c WHERE c.userId=@user AND c.threadId=@thread AND c.type=@type AND c.isDeleted=false",
    parameters: [{ name: "@user", value: owner }, { name: "@thread", value: thread }, { name: "@type", value: "CHAT_MESSAGE" }],
  }, { partitionKey: owner }).fetchAll();
  return resources;
}

export async function canReadSalesforceThread(thread: string, owner: string, ids?: string[]): Promise<boolean> {
  if (!await isPersonalSalesforceUser()) return true;
  if (!ids) return false; // Never infer a whole-thread dependency from one protected answer.
  const messages = await sourceMessages(thread, owner);
  const selected = messages.filter(m => ids.includes(m.id));
  if (selected.length !== new Set(ids).size) return false;
  const visible = await filterSalesforceHistory(selected, thread, owner);
  return selected.every(m => visible.some(v => v.id === m.id && v.content === m.content));
}

export async function canvasSources(document: CanvasDocument, owner: string, previous?: CanvasDocument) {
  const sources = new Set(previous?.sourceMessageIds ?? []);
  // Only server-owned, persisted replies can establish an imported source.
  if (document.sourceContent !== undefined) {
    const matches = (await sourceMessages(document.threadId, owner)).filter(m => m.role === "assistant" && m.content === document.sourceContent);
    if (!matches.length) throw new Error("Canvas source has not been saved");
    matches.forEach(m => sources.add(m.id));
  } else {
    (document.sourceMessageIds ?? []).forEach(id => sources.add(id));
  }
  const ids = Array.from(sources);
  if (!await canReadSalesforceThread(document.threadId, owner, ids)) throw new Error("Canvas source unavailable");
  return ids;
}

export async function canReadCanvas(document: CanvasDocument & {id?:string;canvasAccessSeal?:string}, owner:string) {
  if (!await isPersonalSalesforceUser()) return true;
  if (!document.canvasAccessSeal) return legacyOrigin({id:document.id??"",threadId:document.threadId,content:document.content},owner)==="non_sf";
  return validCanvasSeal(document,owner,document.canvasAccessSeal) && await canReadSalesforceThread(document.threadId,owner,document.sourceMessageIds);
}

/** Sidebar titles are masked using local metadata only, never a Salesforce query. */
export async function protectedThreadIds(owner: string) {
  const { resources } = await HistoryContainer().items.query<{ id:string; threadId: string; historyAccess?:HistoryAccess; salesforceSnapshot?:unknown }>({
    query: "SELECT c.id,c.threadId,c.historyAccess,c.salesforceSnapshot FROM c WHERE c.userId=@user AND c.type=@type AND c.isDeleted=false AND c.role!='user' AND (IS_DEFINED(c.salesforceSnapshot) OR c.historyAccess.sf=true OR NOT IS_DEFINED(c.historyAccess))",
    parameters: [{ name: "@user", value: owner }, { name: "@type", value: "CHAT_MESSAGE" }],
  }, { partitionKey: owner }).fetchAll();
  const index=legacyIndex();
  return new Set([...resources.filter(r=>r.salesforceSnapshot || r.historyAccess?.sf || !(index[`${owner}/${r.id}`]?.origin==="non_sf"&&index[`${owner}/${r.id}`]?.thread===r.threadId)).map(r => r.threadId), ...Object.entries(index).filter(([key,row]) => key.startsWith(owner + "/") && row.origin === "sf").map(([,row]) => row.thread)]);
}

export async function filterSalesforceHistory(messages: ChatMessageModel[], thread: string, owner: string): Promise<ChatMessageModel[]> {
  if (!await isPersonalSalesforceUser()) return messages;
  const checks = new Map<string, Promise<boolean>>();
  const visible = await Promise.all(messages.map(async message => {
    if (message.role === "user") return [message];
    let allowed = false;
    try {
      const access = message.historyAccess;
      if (!access) allowed = legacyOrigin(message, owner) === "non_sf";
      else if (validAccess(access, owner, thread, message.role) && access.hash === digest(JSON.stringify({ content: message.content, image: message.multiModalImage ?? "", name: message.name }))) {
        if (!access.sf) allowed = true;
        else {
          const proofs = access.dependencies ?? (access.proof ? [access.proof] : []);
          const key = JSON.stringify(proofs);
          if (!checks.has(key)) checks.set(key, checkProofs(proofs, thread));
          allowed = await checks.get(key)!;
        }
      }
    } catch { /* Missing signing configuration also hides historical content. */ }
    if (allowed) return [message];
    if (message.role !== "assistant") return [];
    return [{ id: message.id, createdAt: message.createdAt, isDeleted: message.isDeleted, threadId: thread,
      userId: owner, role: "assistant" as const, name: "Azure Chat", type: "CHAT_MESSAGE" as const, content: RESTRICTED_HISTORY }];
  }));
  return visible.flat();
}

export function sealCanvas(document: CanvasDocument, owner: string) {
  return signature("canvas-v1:", { owner, document: validateCanvas(document) });
}
export function validCanvasSeal(document: CanvasDocument, owner: string, seal?: string) {
  if (!personalSalesforceEnabled()) return true;
  try { return Boolean(seal && equal(seal, sealCanvas(document, owner))); } catch { return false; }
}
