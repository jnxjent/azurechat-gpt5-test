import "server-only";
import { getCanvasActor } from "@/features/canvas/canvas-actor";
import { personalSalesforceBase, personalSalesforceEnabled, personalSalesforceForEmail, personalSalesforceUsers, signSalesforceRequest } from "@/features/common/services/salesforce-personal";
import type { ChatMessageModel } from "@/features/chat-page/chat-services/models";

export type SkillSnapshot = ChatMessageModel["salesforceSnapshot"];
export async function isPersonalSkillUser(email: string) {
  if (!personalSalesforceEnabled()) return false;
  const actor = await getCanvasActor();
  // An email/principal mismatch is an enrollment failure, never permission to use shared SF.
  return personalSalesforceForEmail(email) || personalSalesforceUsers().some(v => v.principal === actor.salesforcePrincipal?.toLowerCase());
}
/** Web session or SDK/roster-verified server actor; never a principal from tool input. */
export async function skillPersonalHeaders(url: URL, email: string, thread: string, method: string, body: string) {
  const actor = await getCanvasActor();
  if (!personalSalesforceForEmail(email) || !actor.salesforcePrincipal ||
      actor.email.trim().toLowerCase() !== email.trim().toLowerCase() ||
      (process.env.SF_PERSONAL_SCOPE !== "whitelist" && !personalSalesforceUsers().some(v => v.principal === actor.salesforcePrincipal?.toLowerCase() && v.email === email.trim().toLowerCase())) ||
      process.env.SF_PERSONAL_AUTH_METHOD !== "oauth" || process.env.SF_PERSONAL_SNAPSHOT_POLICY !== "strict" ||
      url.origin !== new URL(personalSalesforceBase()).origin || !thread ||
      !["/api/skills/salesforce/search", "/api/sf/query_nl"].includes(url.pathname) ||
      (url.protocol !== "https:" && !(process.env.NODE_ENV === "development" && url.hostname === "127.0.0.1"))) {
    throw new Error("SkillのSalesforce本人接続を確認できません。");
  }
  return signSalesforceRequest({ principal: actor.salesforcePrincipal, email, thread, url, method, body }, process.env.SF_PERSONAL_SIGNING_KEY ?? "");
}

/** All sources must be verifiable. Never discard a missing proof from a mixed answer. */
export function mergeSkillSnapshots(...sources: SkillSnapshot[]): SkillSnapshot {
  const present = sources.filter((s): s is NonNullable<SkillSnapshot> => Boolean(s));
  if (!present.length) return undefined;
  const first = present[0];
  const proofs = present.flatMap(s => s.proofs ?? (s.proof ? [s.proof] : []));
  const valid = present.every(s => s.orgId === first.orgId && s.userId === first.userId && (s.proofs ? s.proofs.length > 0 : Boolean(s.proof)));
  const distinct = Array.from(new Set(proofs));
  return { ...first, proof: undefined, proofs: valid && distinct.length <= 20 ? distinct : [] };
}
