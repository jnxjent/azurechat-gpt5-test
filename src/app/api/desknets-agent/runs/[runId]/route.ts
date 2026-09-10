import {
  approveDeskNetsAgentRun,
  getDeskNetsAgentRun,
} from "@/features/desknets-agent/desknets-agent-client";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type RouteContext = { params: { runId: string } };

function validIdentifier(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const chatThreadId = request.nextUrl.searchParams.get("chatThreadId")?.trim() ?? "";
  if (!validIdentifier(context.params.runId) || !validIdentifier(chatThreadId)) {
    return NextResponse.json({ status: "failed", message: "Invalid run or chat thread ID." }, { status: 400 });
  }
  const run = await getDeskNetsAgentRun(context.params.runId, chatThreadId);
  return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, context: RouteContext) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "failed", message: "Request body must be valid JSON." }, { status: 400 });
  }
  const chatThreadId = typeof body === "object" && body !== null &&
    "chatThreadId" in body && typeof body.chatThreadId === "string"
    ? body.chatThreadId.trim()
    : "";
  const title = typeof body === "object" && body !== null &&
    "title" in body && typeof body.title === "string"
    ? body.title.normalize("NFKC").trim()
    : "";
  if (!validIdentifier(context.params.runId) || !validIdentifier(chatThreadId)) {
    return NextResponse.json({ status: "failed", message: "Invalid run or chat thread ID." }, { status: 400 });
  }
  if (title.length < 1 || title.length > 100 || /[\r\n\t]/.test(title)) {
    return NextResponse.json({ status: "failed", message: "議題は1～100文字の1行で入力してください。" }, { status: 400 });
  }
  const run = await approveDeskNetsAgentRun(context.params.runId, chatThreadId, title);
  return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
}
