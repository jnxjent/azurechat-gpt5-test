import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { isSalesforceAllowedEmail } from "./salesforce-access";

function allSalesforceUsers() {
  return personalSalesforceEnabled() && process.env.SF_PERSONAL_SCOPE === "whitelist";
}

export function personalSalesforceEnabled() {
  return process.env.SF_PERSONAL_MODE === "true";
}

export function personalSalesforceUsers(): Array<{ principal: string; email: string }> {
  if (!personalSalesforceEnabled()) return [];
  const values = JSON.parse(process.env.SF_PERSONAL_USERS_JSON ?? "[]");
  if (!Array.isArray(values) || values.some(v => !v || !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(v.principal) || typeof v.email !== "string" || !v.email.trim())) throw Error("Invalid Salesforce pilot configuration");
  return values.map(v => ({ principal: v.principal.toLowerCase(), email: v.email.trim().toLowerCase() }));
}

export function personalSalesforceForEmail(email: string) {
  if (allSalesforceUsers()) return isSalesforceAllowedEmail(email);
  return personalSalesforceUsers().some(v => v.email === email.trim().toLowerCase());
}

/** Connection enrollment does not enable personal queries or history filtering. */
export async function salesforceConnectionHeaders(url: URL, email: string, method = "GET") {
  if (!["/api/sf/connection", "/api/sf/oauth/start"].includes(url.pathname) || url.search ||
      (url.pathname === "/api/sf/connection" ? method !== "GET" : method !== "POST") ||
      url.origin !== new URL(personalSalesforceBase()).origin || url.protocol !== "https:") throw Error("Invalid connection endpoint");
  const { getCurrentUser } = await import("@/features/auth-page/helpers");
  const user = await getCurrentUser();
  const users = JSON.parse(process.env.SF_PERSONAL_CONNECT_USERS_JSON ?? "[]");
  if (!Array.isArray(users) || !user.salesforcePrincipal || user.email.trim().toLowerCase() !== email.trim().toLowerCase() ||
      !(allSalesforceUsers() ? isSalesforceAllowedEmail(user.email) : users.some(v => v?.principal?.toLowerCase() === user.salesforcePrincipal?.toLowerCase() && v?.email?.trim().toLowerCase() === email.trim().toLowerCase())) ||
      process.env.SF_PERSONAL_AUTH_METHOD !== "oauth" || process.env.SF_PERSONAL_SNAPSHOT_POLICY !== "strict") throw Error("Connection enrollment is not authorized");
  return signSalesforceRequest({ principal: user.salesforcePrincipal, email, thread: "", url, method }, process.env.SF_PERSONAL_SIGNING_KEY ?? "");
}

export async function isPersonalSalesforceUser() {
  if (!personalSalesforceEnabled()) return false;
  const { getCurrentUser } = await import("@/features/auth-page/helpers");
  const user = await getCurrentUser();
  if (allSalesforceUsers()) return isSalesforceAllowedEmail(user.email);
  // Matching either attribute enrolls the request; an identity mismatch must
  // fail in the signer, never select the shared connection instead.
  return personalSalesforceUsers().some(v => v.email === user.email.trim().toLowerCase() || v.principal === user.salesforcePrincipal?.toLowerCase());
}

/** Read-only pilot, separate from normal chat enrollment and legacy history. */
export async function salesforcePilotSearchHeaders(url: URL, email: string, thread: string) {
  if (url.origin !== new URL(personalSalesforceBase()).origin || url.protocol !== "https:" ||
      url.pathname !== "/api/sf/query_nl" || !thread ||
      Array.from(url.searchParams.keys()).some(key => !["q", "mode"].includes(key))) throw Error("Invalid pilot endpoint");
  const { getCurrentUser } = await import("@/features/auth-page/helpers");
  const user = await getCurrentUser();
  const users = JSON.parse(process.env.SF_PERSONAL_TEST_SEARCH_USERS_JSON ?? "[]");
  if (!Array.isArray(users) || !user.salesforcePrincipal || user.email.trim().toLowerCase() !== email.trim().toLowerCase() ||
      !users.some(v => v?.principal?.toLowerCase() === user.salesforcePrincipal?.toLowerCase() && v?.email?.trim().toLowerCase() === email.trim().toLowerCase()) ||
      process.env.SF_PERSONAL_AUTH_METHOD !== "oauth" || process.env.SF_PERSONAL_SNAPSHOT_POLICY !== "strict") throw Error("Pilot search is not authorized");
  return signSalesforceRequest({ principal: user.salesforcePrincipal, email, thread, url }, process.env.SF_PERSONAL_SIGNING_KEY ?? "");
}

export function personalSalesforceBase() {
  const base = process.env.SF_PERSONAL_GATEWAY_BASE_URL;
  if (!base || base.replace(/\/+$/, "") === process.env.SF_GATEWAY_BASE_URL?.replace(/\/+$/, "")) throw Error("A separate personal Salesforce Gateway is required during the pilot");
  return base;
}

export function signSalesforceRequest(input: {
  principal: string; email: string; thread: string; url: URL; method?: string; body?: string;
}, secret: string) {
  if (secret.length < 32 || !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(input.principal)) {
    throw new Error("Salesforce本人接続の設定を確認してください。");
  }
  const claim = {
    v: 1, principal: input.principal.toLowerCase(), email: input.email.trim().toLowerCase(),
    thread: input.thread, method: input.method ?? "GET", target: input.url.pathname + input.url.search,
    body: createHash("sha256").update(input.body ?? "").digest("hex"),
    iat: Math.floor(Date.now() / 1000), nonce: randomUUID(),
  };
  const identity = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return { "X-AC-Identity": identity, "X-AC-Signature": createHmac("sha256", secret).update(identity).digest("hex") };
}

/** Only the authenticated Web session can select the Salesforce principal. */
export async function salesforcePersonalHeaders(url: URL, email: string, thread: string, method = "GET", body = "") {
  if (!await isPersonalSalesforceUser()) return {};
  if (process.env.SF_PERSONAL_SNAPSHOT_POLICY !== "strict") {
    throw new Error("保存済みSalesforceデータの厳格な権限確認が設定されていないため、本人別接続を開始できません。");
  }
  const { getCurrentUser } = await import("@/features/auth-page/helpers");
  const user = await getCurrentUser();
  if (!user.salesforcePrincipal || user.email.trim().toLowerCase() !== email.trim().toLowerCase() || !(allSalesforceUsers() ? isSalesforceAllowedEmail(user.email) : personalSalesforceUsers().some(v=>v.principal===user.salesforcePrincipal?.toLowerCase()&&v.email===user.email.trim().toLowerCase()))) {
    throw new Error("Salesforce本人接続にはMicrosoftアカウントでログインし直してください。");
  }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV === "development" && url.hostname === "127.0.0.1")) {
    throw new Error("Salesforce本人接続の接続先を確認してください。");
  }
  return signSalesforceRequest({ principal: user.salesforcePrincipal, email, thread, url, method, body }, process.env.SF_PERSONAL_SIGNING_KEY ?? "");
}

export function assertPersonalSalesforceResponse(response: Response, headers: Record<string, string>) {
  if (!personalSalesforceEnabled() && !headers["X-AC-Identity"]) return;
  const raw = headers["X-AC-Identity"];
  const claim = raw ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) : undefined;
  const mode = process.env.SF_PERSONAL_AUTH_METHOD === "oauth" ? "personal-oauth" : "personal-jwt";
  if (response.headers.get("X-SF-Connection-Mode") !== mode ||
      response.headers.get("X-AC-Principal") !== claim?.principal ||
      !/^005[a-z0-9]{15}$/i.test(response.headers.get("X-SF-User-Id") ?? "") ||
      !/^00D[a-z0-9]{15}$/i.test(response.headers.get("X-SF-Org-Id") ?? "")) {
    throw new Error("Gatewayの本人別接続を確認できませんでした。共通接続の結果は使用しません。");
  }
}
