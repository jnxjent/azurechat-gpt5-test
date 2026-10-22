import { userSession } from "@/features/auth-page/helpers";
import { isSalesforceAllowedEmail } from "@/features/common/services/salesforce-access";
import { personalSalesforceBase, salesforceConnectionHeaders } from "@/features/common/services/salesforce-personal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  // Azure may expose an internal URL to Node. Compare against the configured
  // public auth origin, never an untrusted forwarded-host header.
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(process.env.NEXTAUTH_URL ?? request.url).origin;
  } catch {
    return Response.json({ error: "接続元サイトの設定を確認してください。" }, { status: 503, headers });
  }
  if (request.headers.get("origin") !== expectedOrigin) {
    return Response.json({ error: "同じサイトから接続を開始してください。" }, { status: 403, headers });
  }
  const user = await userSession();
  if (!user) return Response.json({ error: "ログインしてください。" }, { status: 401, headers });
  if (!isSalesforceAllowedEmail(user.email)) return Response.json({ error: "Salesforceの利用は許可されていません。" }, { status: 403, headers });
  try {
    if (process.env.SF_PERSONAL_AUTH_METHOD !== "oauth") {
      return Response.json({ error: "本人別OAuth接続は有効になっていません。" }, { status: 403, headers });
    }
    const url = new URL("/api/sf/oauth/start", personalSalesforceBase());
    const signed = await salesforceConnectionHeaders(url, user.email, "POST");
    const response = await fetch(url, { method: "POST", headers: { ...signed, "X-User-Email": user.email.trim().toLowerCase() }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error("oauth_start_failed");
    const data = await response.json();
    const destination = new URL(data.authorization_url);
    const authBase = process.env.SF_PERSONAL_AUTH_BASE ?? "https://test.salesforce.com";
    if (destination.origin !== new URL(authBase).origin || destination.protocol !== "https:" || destination.pathname !== "/services/oauth2/authorize") throw Error("invalid_authorization_url");
    return new Response(null, { status: 303, headers: { ...headers, Location: destination.href } });
  } catch {
    return Response.json({ error: "Salesforce本人接続を開始できませんでした。管理者に設定の確認を依頼してください。" }, { status: 503, headers });
  }
}
