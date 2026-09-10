import "server-only";

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
    const statusResponse = await fetch(
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
  structuredCommand?: DeskNetsStructuredCommand
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
    ...(structuredCommand === undefined ? {} : { structuredCommand }),
  };

  try {
    console.log("[DeskNetsAgent] POST /browser-agent/runs", {
      chatThreadId,
      baseUrl,
      structuredAction: structuredCommand?.action ?? null,
      structuredFacility: structuredCommand?.facility ?? null,
    });
    const response = await fetch(`${baseUrl}/browser-agent/runs`, {
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

    return await pollDeskNetsAgentRun(body, headers);
  } catch (error) {
    console.error("[DeskNetsAgent] request failed:", error);
    return {
      status: "failed",
      message: `DeskNet's Agent request failed: ${String(error)}`,
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
    const response = await fetch(
      `${baseUrl}/browser-agent/runs/${encodeURIComponent(runId)}`,
      { method: "GET", headers, cache: "no-store" },
    );
    const body = await readAgentResponse(response);
    return response.ok
      ? body
      : { ...body, status: "failed", message: responseMessage(body, `DeskNet's Agent returned HTTP ${response.status}.`) };
  } catch (error) {
    return { status: "failed", message: `DeskNet's Agent request failed: ${String(error)}` };
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
    const response = await fetch(
      `${baseUrl}/browser-agent/runs/${encodeURIComponent(runId)}/approve`,
      { method: "POST", headers, body: JSON.stringify({ title }), cache: "no-store" },
    );
    const body = await readAgentResponse(response);
    if (!response.ok) {
      return { ...body, status: "failed", message: responseMessage(body, `DeskNet's Agent returned HTTP ${response.status}.`) };
    }
    return await pollDeskNetsAgentRun(body, headers);
  } catch (error) {
    return { status: "failed", message: `DeskNet's Agent request failed: ${String(error)}` };
  }
}
