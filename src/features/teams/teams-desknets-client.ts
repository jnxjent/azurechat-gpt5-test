import "server-only";
import { createHash } from "crypto";
import { fetchDeskNetsAgent } from "@/features/desknets-agent/desknets-agent-transport";
import type { DeskNetsAgentRunResponse } from "@/features/desknets-agent/desknets-agent-types";

export function teamsDeskNetsOwner(email: string, conversationId: string) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized) || !conversationId) throw new Error("本人を確認できません。");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return { userId: hash(normalized), userEmail: normalized,
    threadId: `teams-desknets-${hash(`${normalized}\n${conversationId}`).slice(0, 40)}` };
}

export type TeamsDeskNetsOwner = ReturnType<typeof teamsDeskNetsOwner>;
export function isTeamsDeskNetsEnabled() {
  return Boolean(process.env.DESKNETS_AGENT_API_URL?.trim()) && process.env.DESKNETS_AGENT_ENABLED !== "false";
}

export async function requestTeamsDeskNets(owner: TeamsDeskNetsOwner, runId?: string,
  input?: { prompt: string; conversationHistory: Array<{role: "user" | "assistant"; content: string}>; defaultFacilityQuery?: string },
): Promise<DeskNetsAgentRunResponse> {
  const base = process.env.DESKNETS_AGENT_API_URL?.replace(/\/+$/, "");
  if (!base) throw new Error("DeskNetsエージェントが設定されていません。");
  const headers: Record<string, string> = { "content-type": "application/json",
    "x-user-id": owner.userId, "x-user-email": owner.userEmail, "x-chat-thread-id": owner.threadId };
  if (process.env.DESKNETS_AGENT_API_KEY?.trim()) headers.authorization = `Bearer ${process.env.DESKNETS_AGENT_API_KEY.trim()}`;
  const response = await fetchDeskNetsAgent(`${base}/browser-agent/runs${runId ? `/${encodeURIComponent(runId)}` : ""}`, {
    method: runId ? "GET" : "POST", headers, cache: "no-store",
    ...(input ? { body: JSON.stringify({ ...owner, site: "desknets", mode: "read", ...input }) } : {}),
  });
  const body = await response.json() as DeskNetsAgentRunResponse;
  if (!response.ok) throw new Error(response.status === 403 ? "この予定調整を参照する権限がありません。" :
    response.status === 404 ? "予定調整の状態が期限切れです。新しく条件を指定してください。" :
    "DeskNetsエージェントに接続できませんでした。処理が開始済みの可能性があるため、状況を確認してください。");
  return body;
}
