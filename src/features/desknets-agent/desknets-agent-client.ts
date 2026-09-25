import "server-only";
import { fetchDeskNetsAgent, deskNetsTransportMessage } from "./desknets-agent-transport";

import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { userHashedId, userSession } from "@/features/auth-page/helpers";
import type {
  DeskNetsAgentRunRequest,
  DeskNetsAgentRunResponse,
} from "./desknets-agent-types";
import type { DeskNetsStructuredCommand } from "./desknets-structured-command";

const POLL_INTERVAL_MS = 500;
// Browser Agent allows runs up to 300 seconds. Keep a small transport margin.
const MAX_POLL_DURATION_MS = 330_000;
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "awaiting_user_input",
  "awaiting_approval",
]);

function responseMessage(
  body: DeskNetsAgentRunResponse,
  fallback: string
): string {
  const message = body.message?.trim();
  if (message) return message;
  const error = body.error?.trim();
  return error || fallback;
}

function getAgentBaseUrl(): string {
  return (process.env.DESKNETS_AGENT_API_URL || "").replace(/\/+$/, "");
}

export function isDeskNetsAgentEnabled(): boolean {
  const enabled = Boolean(getAgentBaseUrl()) && process.env.DESKNETS_AGENT_ENABLED !== "false";
  if (process.env.NODE_ENV !== "production") {
    console.log("[DeskNetsAgent] enabled check", {
      enabled,
      flag: process.env.DESKNETS_AGENT_ENABLED,
      hasApiUrl: Boolean(getAgentBaseUrl()),
    });
  }
  return enabled;
}

async function createAgentHeaders(chatThreadId: string): Promise<Record<string, string>> {
  const [hashedUserId, currentUser] = await Promise.all([
    userHashedId(),
    userSession().catch(() => null),
  ]);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-user-id": hashedUserId,
    "x-chat-thread-id": chatThreadId,
  };
  const apiKey = process.env.DESKNETS_AGENT_API_KEY?.trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (currentUser?.email) headers["x-user-email"] = currentUser.email;
  return headers;
}

async function readAgentResponse(response: Response): Promise<DeskNetsAgentRunResponse> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as DeskNetsAgentRunResponse;
  } catch {
    return { status: "failed", message: raw.slice(0, 1000) };
  }
}

async function pollDeskNetsAgentRun(
  initial: DeskNetsAgentRunResponse,
  headers: Record<string, string>,
): Promise<DeskNetsAgentRunResponse> {
  const baseUrl = getAgentBaseUrl();
  const runId = initial.id || initial.runId;
  if (!runId || TERMINAL_STATUSES.has(initial.status)) return initial;

  const pollDeadline = Date.now() + MAX_POLL_DURATION_MS;
  while (Date.now() < pollDeadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const statusResponse = await fetchDeskNetsAgent(
      `${baseUrl}/browser-agent/runs/${encodeURIComponent(runId)}`,
      { method: "GET", headers, cache: "no-store" },
    );
    const statusBody = await readAgentResponse(statusResponse);
    if (!statusResponse.ok) {
      return {
        ...statusBody,
        id: runId,
        status: "failed",
        message: responseMessage(
          statusBody,
          `DeskNet's Agent status returned HTTP ${statusResponse.status}.`,
        ),
      };
    }
    if (TERMINAL_STATUSES.has(statusBody.status)) return statusBody;
    if (!["queued", "running"].includes(statusBody.status)) {
      return {
        ...statusBody,
        id: runId,
        status: "failed",
        message: `DeskNet's Agent returned unknown status: ${statusBody.status}`,
      };
    }
  }
  return {
    id: runId,
    status: "failed",
    message: "DeskNet's Agent timed out while waiting for the browser run.",
  };
}

export async function runDeskNetsAgent(
  prompt: string,
  chatThreadId: string,
  structuredCommand?: DeskNetsStructuredCommand,
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<DeskNetsAgentRunResponse> {
  const baseUrl = getAgentBaseUrl();
  if (!baseUrl) {
    return {
      status: "failed",
      message: "DeskNet's Agent is not configured.",
    };
  }

  const [hashedUserId, currentUser, headers] = await Promise.all([
    userHashedId(),
    userSession().catch(() => null),
    createAgentHeaders(chatThreadId),
  ]);

  const payload: DeskNetsAgentRunRequest = {
    userId: hashedUserId,
    userEmail: currentUser?.email || undefined,
    threadId: chatThreadId,
    site: "desknets",
    mode: "read",
    prompt,
    conversationHistory,
    ...(structuredCommand === undefined ? {} : { structuredCommand }),
  };

  try {
    console.log("[DeskNetsAgent] POST /browser-agent/runs", {
      chatThreadId,
      baseUrl,
      structuredAction: structuredCommand?.action ?? null,
      structuredActionIsHint: true,
      structuredFacility: structuredCommand?.facility ?? null,
    });
    const response = await fetchDeskNetsAgent(`${baseUrl}/browser-agent/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const body = await readAgentResponse(response);

    if (!response.ok) {
      return {
        ...body,
        status: "failed",
        message: responseMessage(
          body,
          `DeskNet's Agent returned HTTP ${response.status}.`
        ),
      };
    }

    // Only an actually waiting run needs the queue card. For an active run,
    // wait for its result so the chat model receives the numbered candidates
    // or approval request in the same turn.
    const completed = response.headers.get("x-desknets-async-queue") === "1" &&
      body.status === "queued"
      ? body
      : await pollDeskNetsAgentRun(body, headers);
    console.log("[DeskNetsAgent] API result", {
      chatThreadId,
      runId: completed.id || completed.runId,
      status: completed.status,
      resolvedAction: completed.task?.type,
      intentSource: completed.intentSource,
      hasApprovalCard: completed.result?.approvalRequest !== undefined,
      hasError: Boolean(completed.error),
    });
    return completed;
  } catch (error) {
    console.error("[DeskNetsAgent] transport failed");
    return {
      status: "failed",
      message: deskNetsTransportMessage(error),
    };
  }
}

export async function getDeskNetsAgentRun(
  runId: string,
  chatThreadId: string,
): Promise<DeskNetsAgentRunResponse> {
  const baseUrl = getAgentBaseUrl();
  if (!baseUrl) return { status: "failed", message: "DeskNet's Agent is not configured." };
  try {
    const headers = await createAgentHeaders(chatThreadId);
    const response = await fetchDeskNetsAgent(
      `${baseUrl}/browser-agent/runs/${encodeURIComponent(runId)}`,
      { method: "GET", headers, cache: "no-store" },
    );
    const body = await readAgentResponse(response);
    return response.ok
      ? body
      : { ...body, status: "failed", message: responseMessage(body, `DeskNet's Agent returned HTTP ${response.status}.`) };
  } catch (error) {
    return { status: "failed", message: deskNetsTransportMessage(error) };
  }
}

export async function cancelDeskNetsAgentRun(
  runId: string,
  chatThreadId: string,
): Promise<DeskNetsAgentRunResponse> {
  const baseUrl = getAgentBaseUrl();
  if (!baseUrl) return { status: "failed", message: "DeskNet's Agent is not configured." };
  try {
    const response = await fetchDeskNetsAgent(
      `${baseUrl}/browser-agent/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", headers: await createAgentHeaders(chatThreadId), cache: "no-store" },
    );
    const body = await readAgentResponse(response);
    return response.ok ? body : { ...body, status: "failed", message: responseMessage(body, "取消できませんでした。") };
  } catch (error) {
    return { status: "failed", message: deskNetsTransportMessage(error) };
  }
}

export async function getDeskNetsHandoff(runId: string, chatThreadId: string): Promise<{handoffUrl?: string; message?: string}> {
  if (!getAgentBaseUrl()) return {message:"DeskNet's Agent is not configured."};
  try {
    const response = await fetchDeskNetsAgent(`${getAgentBaseUrl()}/browser-agent/runs/${encodeURIComponent(runId)}/handoff`, {
      headers:await createAgentHeaders(chatThreadId),cache:"no-store",
    });
    const body=await response.json();
    return response.ok && typeof body.handoffUrl === "string" ? {handoffUrl:body.handoffUrl} : {message:body.message ?? "引き渡しできません。候補を再作成してください。"};
  } catch { return {message:"引き渡し先を取得できませんでした。再試行してください。"}; }
}

/**
 * Teams WEB会議の状態と発行。
 *
 * 主催者は常に操作者本人。代理主催（秘書が上司名義で作成）は未対応で、
 * 依頼が上司名義でも本人名義へ勝手に置き換えない。
 * アクセストークンはサーバー側のセッションからのみ取り、ブラウザーへは返さない。
 */
export type DeskNetsWebMeetingView = {
  requested: boolean;
  status:
    | "not_requested"
    | "requested"
    | "creating"
    | "created_pending_details"
    | "ready"
    | "failed";
  revision: number;
  joinUrl?: string;
  meetingId?: string;
  passcode?: string;
  passcodeAvailability?: "required" | "not_required" | "unavailable";
  copyText?: string;
  complete: boolean;
  scheduleChanged: boolean;
  notes: string[];
  registered: false;
  error?: string;
  message?: string;
};

/**
 * 委任アクセストークンはJWTから直接読む。NextAuthのセッションに載せるとブラウザーへ
 * 渡るため、セッション経由では取らない。読み取った値はAgent APIへ渡すだけで、
 * ログにも応答本文にも出さない。
 */
async function graphAccessToken(request: NextRequest): Promise<string | undefined> {
  const token = (await getToken({ req: request }).catch(() => null)) as
    | { accessToken?: string; accessTokenExpiresAt?: number }
    | null;
  if (!token?.accessToken) return undefined;
  // 期限切れのトークンはGraphへ送らない。更新はサインインのセッション更新に任せる。
  const expiresAt = token.accessTokenExpiresAt;
  if (typeof expiresAt === "number" && Math.floor(Date.now() / 1000) >= expiresAt - 60) {
    return undefined;
  }
  return token.accessToken;
}

/**
 * 既定では無効。有効にするまでカードにWEB会議の欄を出さず、発行も受け付けない。
 * このフラグはサインイン時に要求する委任スコープも決めるため、
 * オフのまま発行だけ通すと権限不足で失敗する。Agent API側の同名フラグも必要。
 */
function isWebMeetingEnabled(): boolean {
  return process.env.DESKNETS_WEB_MEETING_ENABLED === "true";
}

const WEB_MEETING_UNAVAILABLE: DeskNetsWebMeetingView = {
  requested: false,
  status: "not_requested",
  revision: 0,
  complete: false,
  scheduleChanged: false,
  notes: [],
  registered: false,
};

export async function getDeskNetsWebMeeting(
  runId: string,
  chatThreadId: string,
): Promise<DeskNetsWebMeetingView> {
  if (!getAgentBaseUrl() || !isWebMeetingEnabled()) return WEB_MEETING_UNAVAILABLE;
  try {
    const response = await fetchDeskNetsAgent(
      `${getAgentBaseUrl()}/browser-agent/runs/${encodeURIComponent(runId)}/web-meeting`,
      { headers: await createAgentHeaders(chatThreadId), cache: "no-store" },
    );
    const body = await response.json();
    return response.ok
      ? (body as DeskNetsWebMeetingView)
      : {
          ...WEB_MEETING_UNAVAILABLE,
          message: typeof body?.message === "string"
            ? body.message
            : "WEB会議情報を取得できませんでした。もう一度お試しください。",
        };
  } catch {
    return {
      ...WEB_MEETING_UNAVAILABLE,
      message: "WEB会議情報を取得できませんでした。もう一度お試しください。",
    };
  }
}

export async function createDeskNetsWebMeeting(
  runId: string,
  chatThreadId: string,
  request: NextRequest,
): Promise<{ view?: DeskNetsWebMeetingView; message?: string }> {
  if (!getAgentBaseUrl()) return { message: "DeskNet's Agent is not configured." };
  if (!isWebMeetingEnabled()) {
    return { message: "この環境ではTeams WEB会議の発行が有効になっていません。管理者に連絡してください。" };
  }
  const accessToken = await graphAccessToken(request);
  if (!accessToken) {
    return {
      message:
        "Microsoft 365への接続が確認できません。サインインし直してから、もう一度お試しください。",
    };
  }
  try {
    const headers = await createAgentHeaders(chatThreadId);
    const response = await fetchDeskNetsAgent(
      `${getAgentBaseUrl()}/browser-agent/runs/${encodeURIComponent(runId)}/web-meeting`,
      {
        method: "POST",
        // Never logged and never returned to the browser.
        headers: { ...headers, "x-graph-access-token": accessToken },
        cache: "no-store",
      },
    );
    const body = await response.json();
    return response.ok
      ? { view: body as DeskNetsWebMeetingView }
      : { message: body?.message ?? "Teams会議を作成できませんでした。" };
  } catch {
    return { message: "Teams会議の作成要求を送れませんでした。再試行してください。" };
  }
}

export async function approveDeskNetsAgentRun(
  runId: string,
  chatThreadId: string,
  title: string,
): Promise<DeskNetsAgentRunResponse> {
  const baseUrl = getAgentBaseUrl();
  if (!baseUrl) return { status: "failed", message: "DeskNet's Agent is not configured." };
  try {
    const headers = await createAgentHeaders(chatThreadId);
    const response = await fetchDeskNetsAgent(
      `${baseUrl}/browser-agent/runs/${encodeURIComponent(runId)}/approve`,
      { method: "POST", headers, body: JSON.stringify({ title }), cache: "no-store" },
    );
    const body = await readAgentResponse(response);
    if (!response.ok) {
      return { ...body, status: "failed", message: responseMessage(body, `DeskNet's Agent returned HTTP ${response.status}.`) };
    }
    return response.headers.get("x-desknets-async-queue") === "1" &&
      ["queued", "running"].includes(body.status)
      ? body
      : await pollDeskNetsAgentRun(body, headers);
  } catch (error) {
    return { status: "failed", message: deskNetsTransportMessage(error) };
  }
}
