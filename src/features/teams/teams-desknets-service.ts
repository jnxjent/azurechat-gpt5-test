import "server-only";
import { createHash, randomUUID } from "crypto";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { shouldRouteToDeskNetsAgent } from "@/features/desknets-agent/desknets-agent-intent";
import { profileFacilityPreference } from "@/features/memory/memory-facility";
import type { UserMemory } from "@/features/memory/memory-rules";
import type { DeskNetsAgentRunResponse } from "@/features/desknets-agent/desknets-agent-types";
import { isTeamsDeskNetsEnabled, requestTeamsDeskNets, teamsDeskNetsOwner } from "./teams-desknets-client";

type History = Array<{role: "user" | "assistant"; content: string}>;
type Reply = { text: string; confirmationUrl?: string };
type State = { id: string; userId: string; type: "TEAMS_DESKNETS_STATE"; updatedAt: number;
  threadId?: string; history: History; pendingRunId?: string; deliveryUncertain?: boolean; lastActivityId?: string; lastReply?: Reply; ttl: number };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const statusRequest = /^(?:状況(?:を)?確認(?:して)?|進捗(?:を)?確認(?:して)?|処理状況|続き|確認)[。！!]?$/;
const expiredMessage = "この予定調整は期限切れです。DeskNetsで空き時間を確認する条件をもう一度指定してください。";

export function teamsDeskNetsConfirmationUrl(runId: string, threadId: string): string {
  const base = process.env.NEXTAUTH_URL?.trim();
  if (!base) throw new Error("AzureChatの確認画面URLが設定されていません。");
  const url = new URL("/desknets-agent/confirm", base);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    throw new Error("確認画面はHTTPSで設定してください。");
  url.searchParams.set("runId", runId); url.searchParams.set("chatThreadId", threadId);
  return url.href;
}

export function formatTeamsDeskNetsReply(run: DeskNetsAgentRunResponse, threadId: string): Reply {
  const message = run.result?.assistantMessage?.trim() || run.message?.trim() ||
    run.result?.summary?.trim() || "処理結果を取得できませんでした。条件をもう一度指定してください。";
  const runId = run.id || run.runId;
  if (["queued", "running"].includes(run.status)) return { text: "DeskNetsで予定を確認しています。「状況を確認して」と送ると結果を確認できます。" };
  if (runId && run.result?.approvalRequest && run.status !== "failed" && run.status !== "cancelled") {
    return { text: `${message}\n\nまだ予定は登録していません。確認画面で内容を確認し、DeskNets上の「追加」を手動で押して確定してください。`,
      confirmationUrl: teamsDeskNetsConfirmationUrl(runId, threadId) };
  }
  return { text: `DeskNets：${message}` };
}

/** userEmail must come from the authenticated Teams member lookup, never message text. */
export async function handleTeamsDeskNets(props: {
  message: string; userEmail: string | null; conversationId: string; activityId: string;
  conversationType?: string;
}): Promise<Reply | null> {
  const text = props.message.normalize("NFKC").trim();
  const asksKnowledge = /share\s*point|社内資料|社内文書|手順書|マニュアル|使い方|操作方法|Salesforce|セールスフォース/i.test(text);
  const freshRequest = !asksKnowledge && shouldRouteToDeskNetsAgent(text, []);
  if (!props.userEmail) return freshRequest ? { text: "Teamsの本人情報を確認できません。個人チャットで再度お試しください。" } : null;
  if (props.conversationType && props.conversationType !== "personal") return freshRequest ?
    { text: "予定調整は、このBotとの個人チャットで依頼してください。" } : null;
  const owner = teamsDeskNetsOwner(props.userEmail, props.conversationId);
  const container = HistoryContainer();
  const id = `teams-desknets-${hash(owner.threadId)}`;
  let state: State | undefined;
  try { state = (await container.item(id, owner.userId).read<State>()).resource; }
  catch (error) { if ((error as {code?: number}).code !== 404) throw error; }
  if (state && Date.now() - state.updatedAt > 24 * 60 * 60 * 1000) state = { ...state, threadId: `${owner.threadId}-${randomUUID()}`, history: [], pendingRunId: undefined, deliveryUncertain: false, lastActivityId: undefined, lastReply: undefined };
  const clearContext = async () => { if (state) await container.items.upsert({id, userId: owner.userId, type: "TEAMS_DESKNETS_STATE", threadId: `${owner.threadId}-${randomUUID()}`, updatedAt: Date.now(), history: [], ttl: 86400} satisfies State); };
  if (text === "/reset") { await clearContext(); return null; }
  if (asksKnowledge) { await clearContext(); return null; }
  if (!freshRequest && !shouldRouteToDeskNetsAgent(text, state?.history || []) && !((state?.pendingRunId || state?.deliveryUncertain) && statusRequest.test(text))) {
    await clearContext();
    return null;
  }
  if (!isTeamsDeskNetsEnabled()) return { text: "この環境ではDeskNetsスケジュールエージェントが有効になっていません。" };
  if (state?.lastActivityId === props.activityId && props.activityId && state.lastReply) return state.lastReply;

  // Cosmos lock protects repeated or concurrent Bot deliveries across workers.
  const lockId = `${id}-lock`;
  const lock = { id: lockId, userId: owner.userId, type: "TEAMS_DESKNETS_LOCK", token: randomUUID(), expiresAt: Date.now() + 90000, ttl: 120 };
  let lockEtag: string | undefined;
  const save = async (result: DeskNetsAgentRunResponse, messages: History): Promise<Reply> => {
    const reply = formatTeamsDeskNetsReply(result, owner.threadId);
    const pending = ["queued", "running"].includes(result.status) ? result.id || result.runId : undefined;
    if (!pending) messages.push({role: "assistant", content: `DeskNets：${reply.text.slice(0, 12000)}`});
    await container.items.upsert({ id, userId: owner.userId, type: "TEAMS_DESKNETS_STATE", ttl: 86400,
      threadId: owner.threadId, updatedAt: Date.now(), history: messages.slice(-20), pendingRunId: pending,
      lastActivityId: props.activityId, lastReply: reply } satisfies State);
    return reply;
  };
  try {
    try { lockEtag = (await container.items.create(lock)).resource?._etag; }
    catch (error) {
      if ((error as {code?: number}).code !== 409) throw error;
      const existing = (await container.item(lockId, owner.userId).read<typeof lock & {_etag: string}>()).resource;
      if (!existing || existing.expiresAt > Date.now()) return { text: "予定調整を処理中です。しばらくしてから「状況を確認して」と送ってください。" };
      lockEtag = (await container.item(lockId, owner.userId).replace(lock, { accessCondition: {type: "IfMatch", condition: existing._etag} })).resource?._etag;
    }
    // Refresh after locking so two messages cannot overwrite each other's history.
    try { state = (await container.item(id, owner.userId).read<State>()).resource; }
    catch (error) { if ((error as {code?: number}).code !== 404) throw error; }
    if (state && Date.now() - state.updatedAt > 24 * 60 * 60 * 1000) state = { ...state, threadId: `${owner.threadId}-${randomUUID()}`, history: [], pendingRunId: undefined, deliveryUncertain: false, lastActivityId: undefined, lastReply: undefined };
    if (state?.lastActivityId === props.activityId && props.activityId && state.lastReply) return state.lastReply;
    if (state?.threadId) owner.threadId = state.threadId;
    if (state?.deliveryUncertain) return {text: "前の要求の開始状態を確認できません。自動再実行はしていません。DeskNetsの状態を確認してから、必要な場合は /reset で会話をリセットして依頼し直してください。"};
    let run: DeskNetsAgentRunResponse;
    const history = state?.history || [];
    if (state?.pendingRunId) {
      try { run = await requestTeamsDeskNets(owner, state.pendingRunId); }
      catch { return {text: `${expiredMessage}必要な場合は /reset で会話をリセットしてください。`}; }
      if (!["queued", "running"].includes(run.status) && !statusRequest.test(text)) {
        history.push({role: "assistant", content: `DeskNets：${run.result?.assistantMessage || run.message || "結果を確認しました。"}`});
        state.pendingRunId = undefined;
      } else return await save(run, history);
    }
    let defaultFacilityQuery: string | undefined;
    const { resources } = await container.items.query<UserMemory>({
      query: "SELECT * FROM c WHERE c.userId = @userId AND c.type = @type AND c.isDeleted = false",
      parameters: [{name: "@userId", value: owner.userId}, {name: "@type", value: "USER_MEMORY"}],
    }, {partitionKey: owner.userId}).fetchAll();
    defaultFacilityQuery = profileFacilityPreference(resources);
    const uncertainReply = {text: "要求の開始状態を確認できません。自動再実行はしていません。しばらくしてから状況を確認してください。"};
    await container.items.upsert({id, userId: owner.userId, type: "TEAMS_DESKNETS_STATE", ttl: 86400,
      threadId: owner.threadId, updatedAt: Date.now(), history, deliveryUncertain: true, lastActivityId: props.activityId, lastReply: uncertainReply} satisfies State);
    try {
      run = await requestTeamsDeskNets(owner, undefined, {prompt: text, conversationHistory: history,
        ...(defaultFacilityQuery ? {defaultFacilityQuery} : {})});
    } catch { return uncertainReply; }
    history.push({role: "user", content: text.slice(0, 12000)});
    let reply = await save(run, history);
    const runId = run.id || run.runId;
    const waitUntil = Date.now() + 15000;
    while (runId && ["queued", "running"].includes(run.status) && Date.now() < waitUntil) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try { run = await requestTeamsDeskNets(owner, runId); }
      catch { break; }
      if (!["queued", "running"].includes(run.status)) reply = await save(run, history);
    }
    return reply;

  } finally {
    if (lockEtag) await container.item(lockId, owner.userId).delete({accessCondition: {type: "IfMatch", condition: lockEtag}}).catch(() => undefined);
  }
}
