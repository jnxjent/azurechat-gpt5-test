import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { hashValue, userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { extractAutomaticMemories } from "./automatic-memory-extractor";
import { activeAutomaticMemories, assistantFeedbackClarification, AUTO_MEMORY_DAYS, AUTO_MEMORY_DOCUMENT_BYTES, formatAutomaticMemoryContext, mergeAutomaticMemories } from "./automatic-memory-rules";
import type { AutomaticMemory, AutomaticMemoryCandidate } from "./automatic-memory-rules";

const TYPE = "USER_AUTOMATIC_MEMORY";
const ID = "automatic-memory-v1";
interface StoredAutomaticMemory {
  id: typeof ID;
  type: typeof TYPE;
  userId: string;
  records: AutomaticMemory[];
  ttl: number;
  _etag?: string;
}
const code = (error: unknown) => (error as { code?: number }).code;

async function readOwned(userId: string): Promise<StoredAutomaticMemory | undefined> {
  try {
    const { resource } = await HistoryContainer().item(ID, userId).read<StoredAutomaticMemory>();
    if (resource && (resource.userId !== userId || resource.type !== TYPE)) throw new Error("Invalid automatic memory owner");
    return resource;
  } catch (error) {
    if (code(error) === 404) return undefined;
    throw error;
  }
}

async function persist(userId: string, current: StoredAutomaticMemory | undefined, records: AutomaticMemory[]): Promise<void> {
  const container = HistoryContainer();
  if (!records.length) {
    if (current) await container.item(ID, userId).delete(current._etag ? {
      accessCondition: { type: "IfMatch", condition: current._etag },
    } : undefined);
    return;
  }
  const body: StoredAutomaticMemory = { id: ID, type: TYPE, userId, records, ttl: AUTO_MEMORY_DAYS * 86400 };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > AUTO_MEMORY_DOCUMENT_BYTES) throw new Error("Automatic memory size limit");
  if (current) {
    if (!current._etag) throw new Error("Missing automatic memory concurrency token");
    await container.item(ID, userId).replace(body, { accessCondition: { type: "IfMatch", condition: current._etag } });
  } else await container.items.create(body);
}

async function loadActive(userId: string): Promise<AutomaticMemory[]> {
  const current = await readOwned(userId);
  const records = activeAutomaticMemories(current?.records ?? []);
  // Reads never refresh lastConfirmedAt. Remove expired records on access.
  if (current && JSON.stringify(records) !== JSON.stringify(current.records)) {
    try { await persist(userId, current, records); }
    catch (error) { if (![409, 412, 404].includes(code(error) ?? 0)) throw error; }
  }
  return records;
}

async function saveCandidates(userId: string, candidates: AutomaticMemoryCandidate[], source: string, observationTime: number): Promise<AutomaticMemory[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readOwned(userId);
    const records = mergeAutomaticMemories(current?.records ?? [], candidates, source, Date.now(), observationTime);
    try { await persist(userId, current, records); return records; }
    catch (error) { if (![409, 412].includes(code(error) ?? 0)) throw error; }
  }
  throw new Error("Automatic memory update conflict");
}

/** Server-only: resolve ownership from the authenticated session, never request data. */
async function prepareForOwner(userId: string, message: string, signal?: AbortSignal, sourceId: string = randomUUID()): Promise<string> {
  if (process.env.AUTOMATIC_MEMORY_ENABLED === "false") return "";
  let records: AutomaticMemory[] = [];
  const observationTime = Date.now();
  try {
    records = await loadActive(userId);
    const candidates = await extractAutomaticMemories(message, records, signal);
    if (candidates.length && !signal?.aborted) {
      const source = createHash("sha256").update(sourceId).digest("hex");
      records = await saveCandidates(userId, candidates, source, observationTime);
    }
  } catch {
    console.warn("[automatic-memory] storage unavailable");
  }
  return assistantFeedbackClarification(message) + formatAutomaticMemoryContext(records, message);
}

export async function prepareAutomaticMemory(message: string, signal?: AbortSignal): Promise<string> {
  try { return await prepareForOwner(await userHashedId(), message, signal); }
  catch { return ""; }
}

/** Email must be obtained by the authenticated Teams member lookup, never message text.
 * Group/channel/unknown conversation types must never receive personal context. */
export async function prepareTeamsAutomaticMemory(props: {
  verifiedEmail?: string | null; conversationType?: string; message: string; activityId?: string;
}): Promise<string> {
  if (props.conversationType !== "personal" || !props.verifiedEmail?.trim()) return "";
  return prepareForOwner(hashValue(props.verifiedEmail), props.message, undefined,
    props.activityId ? `teams:${props.activityId}` : randomUUID());
}
