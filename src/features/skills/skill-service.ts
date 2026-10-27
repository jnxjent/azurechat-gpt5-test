import "server-only";
import { createHash } from "node:crypto";
import { getCanvasActor } from "@/features/canvas/canvas-actor";
import { getCurrentUser, hashValue, userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { skillName, validateSkill } from "./skill-rules";
import type { SharedSkill, SkillInput, UserSkill } from "./skill-rules";
import type { OperationInput } from "@azure/cosmos";

const TYPE = "USER_SKILL";
interface StoredSkill extends UserSkill { type: typeof TYPE; userId: string; isDeleted: boolean; ttl: number; ownerName?: string; _etag?: string }
const idFor = (title: string) => `skill-${createHash("sha256").update(skillName(title)).digest("hex")}`;
const publicSkill = (item: StoredSkill): UserSkill => ({ id: item.id, title: item.title, description: item.description,
  content: item.content, enabled: item.enabled, shared: item.shared === true, version: item.version, updatedAt: item.updatedAt });
/** The display name is stored only while a Skill is published. */
async function sharing(input: SkillInput): Promise<Pick<StoredSkill, "shared" | "ownerName">> {
  if (!input.shared) return { shared: false };
  const name = (await getCurrentUser()).name?.trim().slice(0, 80);
  return { shared: true, ownerName: name || "社員" };
}
const condition = (item: StoredSkill) => {
  if (!item._etag) throw new Error("Skillの更新状態を確認できませんでした。");
  return { accessCondition: { type: "IfMatch", condition: item._etag } };
};
async function readOwned(id: string, userId: string): Promise<StoredSkill | undefined> {
  if (!/^skill-[a-f0-9]{64}$/.test(id)) throw new TypeError("Skillが見つかりません。");
  try {
    const { resource } = await HistoryContainer().item(id, userId).read<StoredSkill>();
    if (resource && (resource.type !== TYPE || resource.userId !== userId)) throw new TypeError("Skillが見つかりません。");
    return resource;
  } catch (error) { if ((error as { code?: number }).code === 404) return undefined; throw error; }
}
export async function listUserSkills(): Promise<UserSkill[]> {
  return listOwnedSkills(await userHashedId());
}
/** Server-only actor bridge, populated only after authoritative Teams roster verification. */
export async function listActorSkills(): Promise<UserSkill[]> {
  return listOwnedSkills(hashValue((await getCanvasActor()).email));
}
async function listOwnedSkills(userId: string): Promise<UserSkill[]> {
  const { resources } = await HistoryContainer().items.query<StoredSkill>({
    query: "SELECT * FROM c WHERE c.type = @type AND c.userId = @userId AND c.isDeleted = false",
    parameters: [{ name: "@type", value: TYPE }, { name: "@userId", value: userId }],
  }, { partitionKey: userId }).fetchAll();
  return resources.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicSkill);
}
/** Other employees' published Skills, read-only. Callers copy them into their own Skills. */
export async function listSharedSkills(): Promise<SharedSkill[]> {
  const userId = await userHashedId();
  const { resources } = await HistoryContainer().items.query<StoredSkill>({
    query: "SELECT TOP 200 * FROM c WHERE c.type = @type AND c.shared = true AND c.isDeleted = false AND c.userId != @userId",
    parameters: [{ name: "@type", value: TYPE }, { name: "@userId", value: userId }],
  }).fetchAll();
  return resources.filter(item => item.type === TYPE && item.shared === true && !item.isDeleted && item.userId !== userId)
    .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(item => ({ ref: createHash("sha256").update(`${item.userId}:${item.id}`).digest("hex").slice(0, 32),
      title: item.title, description: item.description, content: item.content,
      ownerName: item.ownerName?.trim() || "社員", updatedAt: item.updatedAt }));
}
export async function getUserSkill(id: string): Promise<UserSkill> {
  const item = await readOwned(id, await userHashedId());
  if (!item || item.isDeleted) throw new TypeError("Skillが見つかりません。");
  return publicSkill(item);
}
export async function createUserSkill(value: unknown): Promise<UserSkill> {
  const input = validateSkill(value);
  const userId = await userHashedId();
  const id = idFor(input.title);
  const existing = await readOwned(id, userId);
  if (existing && !existing.isDeleted) throw new TypeError("同じ名前のSkillがあります。別の名前を指定してください。");
  const item: StoredSkill = { ...input, ...await sharing(input), id, type: TYPE, userId, isDeleted: false, ttl: -1,
    version: (existing?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
  try {
    if (existing) await HistoryContainer().item(id, userId).replace(item, condition(existing));
    else await HistoryContainer().items.create(item);
  } catch (error) {
    if ([409,412].includes((error as {code?:number}).code ?? 0)) throw new TypeError("同じ名前のSkillが更新されています。一覧を再読み込みしてください。");
    throw error;
  }
  return publicSkill(item);
}
export async function updateUserSkill(id: string, value: unknown, version: number): Promise<UserSkill> {
  const input = validateSkill(value);
  const userId = await userHashedId();
  const current = await readOwned(id, userId);
  if (!current || current.isDeleted) throw new TypeError("Skillが見つかりません。");
  if (!Number.isInteger(version) || current.version !== version) throw new TypeError("Skillが更新されています。一覧を再読み込みしてください。");
  const nextId = idFor(input.title);
  const item: StoredSkill = { ...input, ...await sharing(input), id: nextId, type: TYPE, userId, isDeleted: false, ttl: -1,
    version: current.version + 1, updatedAt: new Date().toISOString() };
  if (nextId === id) {
    try { await HistoryContainer().item(id, userId).replace(item, condition(current)); }
    catch (error) { if ((error as {code?:number}).code === 412) throw new TypeError("Skillが更新されています。一覧を再読み込みしてください。"); throw error; }
  } else {
    const target = await readOwned(nextId, userId);
    if (target && !target.isDeleted) throw new TypeError("同じ名前のSkillがあります。別の名前を指定してください。");
    item.version = Math.max(current.version, target?.version ?? 0) + 1;
    condition(current);
    if (target) condition(target);
    const operations: OperationInput[] = [
      { operationType: "Replace", id, ifMatch: current._etag, resourceBody: { ...current,
        isDeleted: true, enabled: false, version: current.version + 1, updatedAt: item.updatedAt } },
      target ? { operationType: "Replace", id: nextId, ifMatch: target._etag, resourceBody: { ...item } }
        : { operationType: "Create", resourceBody: { ...item } },
    ];
    const result = await HistoryContainer().items.batch(operations, userId);
    if ((result.code ?? 500) >= 300 || result.result?.length !== 2 || result.result.some(entry => entry.statusCode >= 300)) {
      throw new TypeError("名前を変更できませんでした。Skillが更新されている可能性があります。一覧を再読み込みしてください。");
    }
  }
  return publicSkill(item);
}
export async function deleteUserSkill(id: string, version: number): Promise<void> {
  const userId = await userHashedId();
  const current = await readOwned(id,userId);
  if (!current || current.isDeleted) throw new TypeError("Skillが見つかりません。");
  if (!Number.isInteger(version) || current.version !== version) throw new TypeError("Skillが更新されています。一覧を再読み込みしてください。");
  try {
    await HistoryContainer().item(id,userId).replace({ ...current, isDeleted: true, enabled: false,
      version: current.version + 1, updatedAt: new Date().toISOString() }, condition(current));
  } catch (error) { if ((error as {code?:number}).code === 412) throw new TypeError("Skillが更新されています。一覧を再読み込みしてください。"); throw error; }
}
