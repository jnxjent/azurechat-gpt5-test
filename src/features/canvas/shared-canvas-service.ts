import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { isSalesforceAllowedEmail } from "@/features/common/services/salesforce-access";
import { retrieveCanvasSource, revalidateCanvasSource, type Source } from "./canvas-source";
import { validateCanvas, type CanvasDocument } from "./canvas-rules";

export type CanvasShareUser = { principal: string; email: string };
type SharedCanvas = { id: string; userId: "CANVAS_SHARE"; type: "SHARED_CANVAS"; ttl: -1; owner: CanvasShareUser; readers: CanvasShareUser[]; enabled: boolean; revision: number; updatedAt: string; document: CanvasDocument; source: Source; seal: string; _etag?: string };
const partition = "CANVAS_SHARE";
export class CanvasShareError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function participants(): CanvasShareUser[] {
  const values = JSON.parse(process.env.CANVAS_SHARE_USERS_JSON ?? "[]");
  if (!Array.isArray(values) || values.some(v => !v || typeof v.principal !== "string" || !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(v.principal) || typeof v.email !== "string" || !v.email.includes("@"))) throw new CanvasShareError(503, "共有対象者の設定を確認してください。");
  const users = values.map(v => ({ principal: v.principal.toLowerCase(), email: v.email.trim().toLowerCase() }));
  if (new Set(users.map(v => v.principal)).size !== users.length || new Set(users.map(v => v.email)).size !== users.length) throw new CanvasShareError(503, "共有対象者の登録が重複しています。");
  return users;
}
export async function currentCanvasShareUser(): Promise<CanvasShareUser> {
  const user = await getCurrentUser();
  if (!isSalesforceAllowedEmail(user.email) || !user.salesforcePrincipal) throw new CanvasShareError(403, "Microsoftアカウントでログインし直してください。");
  const found = participants().find(v => v.principal === user.salesforcePrincipal?.toLowerCase() && v.email === user.email.trim().toLowerCase());
  if (!found) throw new CanvasShareError(403, "Canvas共有の利用は許可されていません。");
  return found;
}
function sameUser(a: CanvasShareUser, b: CanvasShareUser) { return a.principal === b.principal && a.email === b.email; }
function signature(record: Omit<SharedCanvas, "seal"> | SharedCanvas) {
  const secret = process.env.SF_PERSONAL_SIGNING_KEY ?? "";
  if (secret.length < 32) throw new CanvasShareError(503, "Canvas共有の署名設定を確認してください。");
  const { id, userId, type, ttl, owner, readers, enabled, revision, updatedAt, document, source } = record;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return createHmac("sha256", secret).update("shared-canvas-v1:" + JSON.stringify(canonical({ id, userId, type, ttl, owner, readers, enabled, revision, updatedAt, document: validateCanvas(document), source }))).digest("hex");
}
function valid(record: SharedCanvas) {
  return /^[a-f0-9]{64}$/.test(record.seal ?? "") && timingSafeEqual(Buffer.from(record.seal, "hex"), Buffer.from(signature(record), "hex"));
}
function requireId(id: string) { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new CanvasShareError(404, "Canvasが見つからないか、共有が解除されています。"); }
async function read(id: string): Promise<SharedCanvas> {
  requireId(id);
  try {
    const { resource } = await HistoryContainer().item(`shared-canvas-${id}`, partition).read<SharedCanvas>();
    if (!resource || !resource._etag || resource.type !== "SHARED_CANVAS" || resource.userId !== partition || resource.id !== `shared-canvas-${id}` || !valid(resource)) throw new CanvasShareError(404, "Canvasが見つからないか、共有が解除されています。");
    return resource;
  } catch (e) { if ((e as { code?: number }).code === 404) throw new CanvasShareError(404, "Canvasが見つからないか、共有が解除されています。"); throw e; }
}
function authorized(record: SharedCanvas, user: CanvasShareUser) {
  const owner = sameUser(record.owner, user);
  if (!owner && (!record.enabled || !record.readers.some(v => sameUser(v, user)))) throw new CanvasShareError(404, "Canvasが見つからないか、共有が解除されています。");
  return owner;
}
function management(record: SharedCanvas, owner: boolean) { return { revision: record.revision, updatedAt: record.updatedAt, owner, ...(owner ? { readers: record.readers.map(v => v.email), enabled: record.enabled } : {}) }; }
export async function createSharedCanvas(query: string) {
  const user = await currentCanvasShareUser(), id = randomUUID();
  const snapshot = await retrieveCanvasSource(user, { provider: "salesforce", query: query.trim() });
  const record: SharedCanvas = { id: `shared-canvas-${id}`, userId: partition, type: "SHARED_CANVAS", ttl: -1, owner: user, readers: [], enabled: false, revision: 1, updatedAt: new Date().toISOString(), ...snapshot, seal: "" };
  record.seal = signature(record);
  await HistoryContainer().items.create(record);
  return { id, ...management(record, true) };
}
export async function getSharedCanvas(id: string) {
  const user = await currentCanvasShareUser(), record = await read(id), owner = authorized(record, user);
  const allowed = await revalidateCanvasSource(record.source, user);
  // Re-read after remote checks so revocation/update during a check wins.
  const latest = await read(id); authorized(latest, user);
  if (latest._etag !== record._etag) throw new CanvasShareError(409, "更新されています。再読み込みしてください。");
  if (!allowed && !owner) throw new CanvasShareError(403, "現在のSalesforce権限でこのCanvasを参照できません。");
  return { ...management(record, owner), restricted: !allowed, ...(allowed ? { document: record.document, ...(owner ? { query: record.source.query } : {}) } : {}) };
}
export async function changeSharedCanvas(id: string, input: { revision?: unknown; action?: unknown; readers?: unknown; enabled?: unknown }) {
  const user = await currentCanvasShareUser(), record = await read(id);
  if (!sameUser(record.owner, user)) throw new CanvasShareError(404, "Canvasが見つからないか、操作できません。");
  if (input.revision !== record.revision || !record._etag) throw new CanvasShareError(409, "別の画面で更新されています。再読み込みしてください。");
  let next = { ...record };
  if (input.action === "access") {
    if (!Array.isArray(input.readers) || input.readers.length > 50 || input.readers.some(v => typeof v !== "string") || typeof input.enabled !== "boolean") throw new CanvasShareError(400, "共有先を確認してください。");
    const emails = Array.from(new Set((input.readers as string[]).map(v => v.trim().toLowerCase()).filter(Boolean)));
    const available = participants();
    const readers = emails.map(email => available.find(v => v.email === email && v.principal.split(":")[0] === user.principal.split(":")[0]));
    if (readers.some(v => !v)) throw new CanvasShareError(400, "未登録の共有先が含まれています。");
    if (input.enabled && !await revalidateCanvasSource(record.source, user)) throw new CanvasShareError(403, "共有前に元データの参照権限を確認してください。");
    next.readers = readers as CanvasShareUser[]; next.enabled = input.enabled;
  } else if (input.action === "refresh") {
    next = { ...next, ...await retrieveCanvasSource(user, { provider: record.source.provider, query: record.source.query }) };
    next.document.version = record.document.version + 1;
  } else throw new CanvasShareError(400, "操作を確認してください。");
  next.revision++; next.updatedAt = new Date().toISOString(); delete next._etag;
  next.seal = signature(next);
  try { await HistoryContainer().item(record.id, partition).replace(next, { accessCondition: { type: "IfMatch", condition: record._etag } }); }
  catch (e) { if ([409, 412].includes((e as { code: number }).code)) throw new CanvasShareError(409, "別の画面で更新されています。再読み込みしてください。"); throw e; }
  return management(next, true);
}
