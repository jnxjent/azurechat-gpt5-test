import { userHashedId } from "@/features/auth-page/helpers";
import { fetchDeskNetsAgent } from "@/features/desknets-agent/desknets-agent-transport";
import { sealDeskNetsCredentials } from "@/features/desknets-agent/credential-envelope";
import { isAllowedCredentialOrigin } from "@/features/desknets-agent/credential-request-origin";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function forward(method: "GET" | "POST" | "DELETE", payload?: unknown, knownUserId?: string) {
  const baseUrl = process.env.DESKNETS_AGENT_API_URL?.replace(/\/+$/, "");
  if (!baseUrl) return NextResponse.json({ message: "DeskNet's Agent is not configured." }, { status: 503 });
  let userId: string;
  try {
    userId = knownUserId ?? await userHashedId();
  } catch {
    return NextResponse.json({ message: "Sign in to Azure Chat first." }, { status: 401 });
  }
  try {
    const headers: Record<string, string> = { "x-user-id": userId };
    const apiKey = process.env.DESKNETS_AGENT_API_KEY?.trim();
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (method === "POST") headers["content-type"] = "application/json";
    const response = await fetchDeskNetsAgent(`${baseUrl}/browser-agent/credentials`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({ message: "Credential service returned an invalid response." }));
    return NextResponse.json(body, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ message: "DeskNet's credential service is unavailable." }, { status: 502 });
  }
}

export async function GET() {
  const response = await forward("GET");
  if (!response.ok) return response;
  const body = await response.json();
  return NextResponse.json({
    ...body,
    transportReady: body.transportReady === true &&
      /^[A-Za-z0-9_-]{43}$/.test(process.env.DESKNETS_CREDENTIAL_TRANSPORT_KEY ?? ""),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedCredentialOrigin(origin, request.nextUrl.origin, process.env.NEXTAUTH_URL)) {
    return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" ||
      typeof (body as Record<string, unknown>).username !== "string" ||
      typeof (body as Record<string, unknown>).password !== "string") {
    return NextResponse.json({ message: "DeskNet's ID and password are required." }, { status: 400 });
  }
  const { username, password } = body as { username: string; password: string };
  if (!username.trim() || username.length > 200 || !password || password.length > 1024) {
    return NextResponse.json({ message: "Invalid DeskNet's credentials." }, { status: 400 });
  }
  let userId: string;
  try {
    userId = await userHashedId();
  } catch {
    return NextResponse.json({ message: "Sign in to Azure Chat first." }, { status: 401 });
  }
  try {
    const envelope = sealDeskNetsCredentials(userId, username, password);
    return forward("POST", envelope, userId);
  } catch {
    return NextResponse.json({ message: "DeskNet's credential transport is not configured." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isAllowedCredentialOrigin(request.headers.get("origin"), request.nextUrl.origin, process.env.NEXTAUTH_URL)) {
    return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
  }
  return forward("DELETE");
}
