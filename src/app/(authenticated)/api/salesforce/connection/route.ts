import { userSession } from "@/features/auth-page/helpers";
import { isSalesforceAllowedEmail } from "@/features/common/services/salesforce-access";
import { personalSalesforceBase, salesforceConnectionHeaders, assertPersonalSalesforceResponse } from "@/features/common/services/salesforce-personal";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  const user = await userSession();
  if (!user) return Response.json({ error: "ログインしてください。" }, { status: 401, headers });
  if (!isSalesforceAllowedEmail(user.email)) return Response.json({ error: "Salesforceの利用は許可されていません。" }, { status: 403, headers });
  try {
    const base = personalSalesforceBase();
    if (!base) throw Error("missing_gateway");
    const url = new URL("/api/sf/connection", base);
    const personalHeaders = await salesforceConnectionHeaders(url, user.email);
    const response = await fetch(url, { headers: { ...personalHeaders, "X-User-Email": user.email.trim().toLowerCase() }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
    if (response.ok) assertPersonalSalesforceResponse(response, personalHeaders);
    const data = await response.json();
    if (!response.ok || data.ok !== true) return Response.json({ connected: false, error: "Salesforce本人接続を確認できませんでした。管理者に接続設定の確認を依頼してください。" }, { status: response.status >= 400 ? response.status : 502, headers });
    return Response.json({ connected: true, mode: data.mode, orgId: data.org_id, userId: data.user_id }, { headers });
  } catch {
    return Response.json({ connected: false, error: "Salesforce本人接続を確認できませんでした。共通アカウントでは代用しません。" }, { status: 503, headers });
  }
}
