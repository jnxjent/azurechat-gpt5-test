import { userHashedId } from "@/features/auth-page/helpers";
import { fetchDeskNetsAgent } from "@/features/desknets-agent/desknets-agent-transport";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const threadId = request.nextUrl.searchParams.get("chatThreadId") ?? "";
  if (!threadId || threadId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(threadId)) {
    return NextResponse.json({ message: "Invalid chat thread ID." }, { status: 400 });
  }
  let userId: string;
  try {
    userId = await userHashedId();
  } catch {
    return NextResponse.json({ message: "Sign in to Azure Chat first." }, { status: 401 });
  }
  const baseUrl = process.env.DESKNETS_AGENT_API_URL?.replace(/\/+$/, "");
  if (!baseUrl) return NextResponse.json({ message: "DeskNet's Agent is not configured." }, { status: 503 });
  try {
    const headers: Record<string, string> = {
      "x-user-id": userId,
      "x-chat-thread-id": threadId,
    };
    const apiKey = process.env.DESKNETS_AGENT_API_KEY?.trim();
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetchDeskNetsAgent(
      `${baseUrl}/browser-agent/queue?threadId=${encodeURIComponent(threadId)}`,
      { method: "GET", headers, cache: "no-store" },
    );
    const body = await response.json().catch(() => ({ status: "unknown" }));
    return NextResponse.json(body, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ status: "unknown" }, { status: 502 });
  }
}
