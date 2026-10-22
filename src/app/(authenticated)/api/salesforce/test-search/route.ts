import { randomUUID } from "node:crypto";
import { userSession } from "@/features/auth-page/helpers";
import { isSalesforceAllowedEmail } from "@/features/common/services/salesforce-access";
import { personalSalesforceBase, salesforcePilotSearchHeaders, assertPersonalSalesforceResponse } from "@/features/common/services/salesforce-personal";
import { salesforceReadText } from "@/features/common/services/salesforce-read-result";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    if (request.headers.get("origin") !== new URL(process.env.NEXTAUTH_URL ?? request.url).origin) return Response.json({ error: "同じサイトから検索してください。" }, { status: 403, headers });
    const user = await userSession();
    if (!user) return Response.json({ error: "ログインしてください。" }, { status: 401, headers });
    if (!isSalesforceAllowedEmail(user.email)) return Response.json({ error: "Salesforceの利用は許可されていません。" }, { status: 403, headers });
    const raw = await request.text();
    if (raw.length > 4096) return Response.json({ error: "質問を短くしてください。" }, { status: 400, headers });
    let input;
    try { input = JSON.parse(raw); } catch { return Response.json({ error: "質問を確認してください。" }, { status: 400, headers }); }
    const q = typeof input?.q === "string" ? input.q.trim() : "";
    if (!q || q.length > 1000) return Response.json({ error: "質問は1〜1000文字で入力してください。" }, { status: 400, headers });
    const url = new URL("/api/sf/query_nl", personalSalesforceBase());
    url.searchParams.set("q", q); url.searchParams.set("mode", "real");
    // Every search is independent. No old conversation or memory is read.
    const thread = `pilot-${randomUUID()}`;
    const signed = await salesforcePilotSearchHeaders(url, user.email, thread);
    const response = await fetch(url, { headers: { ...signed, "X-User-Email": user.email.trim().toLowerCase(), "X-Chat-Thread-Id": thread }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(90000) });
    if (!response.ok) return Response.json({ error: "本人のSalesforce検索を実行できませんでした。接続状態・権限・検索条件を確認してください。" }, { status: response.status, headers });
    assertPersonalSalesforceResponse(response, signed);
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items.slice(0, 20).map((item: unknown) => {
      if (!item || typeof item !== "object") return {};
      return Object.fromEntries(Object.entries(item).filter(([key, value]) => !key.startsWith("_") && key !== "attributes" && (value === null || ["string", "number", "boolean"].includes(typeof value))));
    }) : [];
    return Response.json({ text: salesforceReadText(data, true) ?? data.clarification ?? data.zero_reason_message ?? "本人のSalesforce権限で取得した結果です。", items,
      total: Number.isSafeInteger(data.total_count) ? data.total_count : null,
      userId: response.headers.get("X-SF-User-Id"), orgId: response.headers.get("X-SF-Org-Id") }, { headers });
  } catch {
    return Response.json({ error: "本人別検索を確認できませんでした。ログイン状態と試験対象者の設定を確認してください。" }, { status: 503, headers });
  }
}
