import "server-only";
import { randomUUID } from "node:crypto";
import type { OperationInput } from "@azure/cosmos";
import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { memoryKind, normalizeMemoryName } from "./memory-rules";
import type { MemoryMode, UserMemory } from "./memory-rules";
import { buildLearnedLesson, LESSON_MEMO_CONTENT, LESSON_MEMO_TITLE } from "./learned-lesson";

const MEMORY_TYPE = "USER_MEMORY";

interface StoredMemory extends UserMemory {
  type: typeof MEMORY_TYPE;
  userId: string;
  createdAt: string;
  isDeleted: boolean;
  _etag?: string;
}

export interface MemoryInput {
  kind?: "memo" | "skill";
  title: string;
  content: string;
  mode: MemoryMode;
  triggers: string[];
  enabled?: boolean;
}

export function validateMemoryInput(value: unknown): MemoryInput {
  if (!value || typeof value !== "object") throw new TypeError("メモの内容がありません。");
  const input = value as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!title || title.length > 120) throw new TypeError("メモ名は1〜120文字で入力してください。");
  if (!content || content.length > 12000) throw new TypeError("本文は1〜12000文字で入力してください。");
  if (input.kind !== undefined && input.kind !== "memo" && input.kind !== "skill") throw new TypeError("種類が正しくありません。");
  if (input.mode !== undefined && !["always", "required", "manual"].includes(String(input.mode))) throw new TypeError("参照条件が正しくありません。");
  const kind = input.kind ?? (input.mode === "manual" || input.mode === "required" ? "skill" : "memo");
  const triggers = Array.isArray(input.triggers) ? input.triggers : [];
  if (triggers.length > 8 || triggers.some((item) => typeof item !== "string" || item.trim().length > 80)) {
    throw new TypeError("適用語は80文字以内で8件まで指定できます。");
  }
  const cleanTriggers = triggers.map((item: string) => item.trim()).filter(Boolean);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new TypeError("有効・無効の指定が正しくありません。");
  }
  return { title, content, kind, mode: kind === "memo" ? "always" : "manual", triggers: cleanTriggers,
    enabled: input.enabled === undefined ? true : input.enabled === true };
}

export async function listUserMemories(): Promise<UserMemory[]> {
  const userId = await userHashedId();
  const { resources } = await HistoryContainer().items.query<StoredMemory>({
    query: "SELECT * FROM c WHERE c.type = @type AND c.userId = @userId AND c.isDeleted = false",
    parameters: [{ name: "@type", value: MEMORY_TYPE }, { name: "@userId", value: userId }],
  }, { partitionKey: userId }).fetchAll();
  return resources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => ({
    kind: memoryKind(item), learnedLesson: item.learnedLesson,
    id: item.id, title: item.title, content: item.content, mode: memoryKind(item) === "memo" ? "always" : "manual",
    triggers: item.triggers, enabled: item.enabled, version: item.version, updatedAt: item.updatedAt,
  }));
}

async function findOwnedMemory(id: string, includeDeleted = false): Promise<StoredMemory | undefined> {
  const userId = await userHashedId();
  const { resources } = await HistoryContainer().items.query<StoredMemory>({
    query: `SELECT * FROM c WHERE c.type = @type AND c.userId = @userId AND c.id = @id${includeDeleted ? "" : " AND c.isDeleted = false"}`,
    parameters: [{ name: "@type", value: MEMORY_TYPE }, { name: "@userId", value: userId }, { name: "@id", value: id }],
  }, { partitionKey: userId }).fetchAll();
  return resources[0];
}

export async function createUserMemory(value: unknown): Promise<UserMemory> {
  const input = validateMemoryInput(value);
  await assertAvailableName(input.title);
  const userId = await userHashedId();
  const now = new Date().toISOString();
  const item: StoredMemory = {
    ...input, id: `memory-${randomUUID()}`, userId, type: MEMORY_TYPE,
    createdAt: now, updatedAt: now, version: 1, isDeleted: false,
    enabled: input.enabled ?? true,
  };
  await HistoryContainer().items.create(item);
  return item;
}

export async function updateUserMemory(id: string, value: unknown, expectedVersion: number): Promise<UserMemory> {
  const current = await findOwnedMemory(id);
  if (!current) throw new TypeError("メモが見つかりません。");
  if (current.version !== expectedVersion) throw new TypeError("メモが更新されています。再読み込みしてから編集してください。");
  const input = validateMemoryInput(value);
  await assertAvailableName(input.title, id);
  const updated: StoredMemory = { ...current, ...input, enabled: input.enabled ?? true,
    updatedAt: new Date().toISOString(), version: current.version + 1 };
  await HistoryContainer().item(id, current.userId).replace(updated, current._etag ? {
    accessCondition: { type: "IfMatch", condition: current._etag },
  } : undefined);
  return updated;
}

export async function deleteUserMemory(id: string): Promise<void> {
  const current = await findOwnedMemory(id);
  if (!current) throw new TypeError("メモが見つかりません。");
  await HistoryContainer().item(id, current.userId).replace({ ...current, isDeleted: true,
    enabled: false, updatedAt: new Date().toISOString(), version: current.version + 1 }, current._etag ? {
    accessCondition: { type: "IfMatch", condition: current._etag },
  } : undefined);
}

async function assertAvailableName(title: string, exceptId?: string): Promise<void> {
  const memories = await listUserMemories();
  if (memories.some((item) => item.id !== exceptId && normalizeMemoryName(item.title) === normalizeMemoryName(title))) {
    throw new TypeError("同じ保存名のメモ・スキルがあります。別の名前を指定してください。");
  }
}

export async function renameUserMemory(memory: UserMemory, title: string): Promise<UserMemory> {
  return updateUserMemory(memory.id, { ...memory, title, kind: memoryKind(memory) }, memory.version);
}

export async function recordLearnedLesson(props: {
  feedback: string;
  threadId: string;
  previousAssistant?: string;
  previousUser?: string;
}): Promise<{ skill: UserMemory; memo: UserMemory }> {
  const userId = await userHashedId();
  const now = new Date().toISOString();
  const id = `memory-${randomUUID()}`;
  const lesson = buildLearnedLesson({ ...props, reportedAt: now, suffix: id.slice(-8) });
  const input = validateMemoryInput({ ...lesson, kind: "skill", mode: "manual", triggers: ["LearnedLesson"] });
  await assertAvailableName(input.title);
  const skill: StoredMemory = { ...input, id, userId, type: MEMORY_TYPE, enabled: true,
    createdAt: now, updatedAt: now, version: 1, isDeleted: false,
    learnedLesson: { source: "user_feedback", status: "reported", threadId: props.threadId, reportedAt: now } };
  const memoId = "memory-learnedlesson-common-md";
  // Same user partition: either both records are saved, or neither is saved.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await findOwnedMemory(memoId, true);
    const memo: StoredMemory = current && !current.isDeleted ? current : {
      id: memoId, userId, type: MEMORY_TYPE, title: LESSON_MEMO_TITLE, content: LESSON_MEMO_CONTENT,
      kind: "memo", mode: "always", triggers: [], enabled: true, isDeleted: false,
      createdAt: current?.createdAt ?? now, updatedAt: now, version: (current?.version ?? 0) + 1,
    };
    const operations: OperationInput[] = [{ operationType: "Create", resourceBody: { ...skill } }];
    if (!current) operations.push({ operationType: "Create", resourceBody: { ...memo } });
    else if (current.isDeleted) operations.push({ operationType: "Replace", id: memoId,
      resourceBody: { ...memo }, ifMatch: current._etag });
    const result = await HistoryContainer().items.batch(operations, userId);
    if ((result.code ?? 500) >= 200 && (result.code ?? 500) < 300 && result.result?.length === operations.length && result.result.every((item) => item.statusCode >= 200 && item.statusCode < 300)) {
      return { skill, memo };
    }
    if (attempt === 0 && (result.code === 409 || result.code === 412 || result.result?.some((item) => item.statusCode === 409 || item.statusCode === 412))) continue;
    throw new Error("LearnedLessonを保存できませんでした。再度お試しください。");
  }
  throw new Error("LearnedLessonを保存できませんでした。");
}
