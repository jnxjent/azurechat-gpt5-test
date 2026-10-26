import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CanvasActor } from "@/features/canvas/canvas-actor";

export type SkillCardClaim = { v: 1; owner: string; bot: string; conversation: string; expires: number; skillId: string; version: number; request: string; accounts?: string[] };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function key() {
  const key = process.env.SF_PERSONAL_SIGNING_KEY || process.env.NEXTAUTH_SECRET || "";
  if (key.length < 32) throw Error("Skill card signing unavailable");
  return key;
}
const sign = (raw: string) => createHmac("sha256", key()).update("teams-skill-v1:" + raw).digest("hex");
function binding(actor: CanvasActor, conversation: string) {
  const bot = process.env.TEAMS_BOT_ID || process.env.AZURE_AD_CLIENT_ID;
  if (!bot || !actor.salesforcePrincipal || !actor.email || !conversation) throw Error("Skill card identity unavailable");
  return { owner: digest(JSON.stringify([actor.salesforcePrincipal, actor.email])), conversation: digest(conversation), bot: digest(bot) };
}
export function issueSkillCard(actor: CanvasActor, conversation: string, input: Pick<SkillCardClaim, "skillId" | "version" | "request" | "accounts">): string {
  const claim: SkillCardClaim = { ...input, ...binding(actor, conversation), v: 1, expires: Math.floor(Date.now() / 1000) + 600 };
  if (!valid(claim)) throw Error("Invalid Skill card");
  const raw = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return raw + "." + sign(raw);
}
function valid(claim: SkillCardClaim) {
  return claim.v === 1 && /^skill-[a-f0-9]{64}$/.test(claim.skillId) && Number.isSafeInteger(claim.version) && claim.version > 0 &&
    typeof claim.request === "string" && claim.request.trim().length > 0 && claim.request.length <= 2000 &&
    (claim.accounts === undefined || Array.isArray(claim.accounts) && claim.accounts.length > 0 && claim.accounts.length <= 50 && claim.accounts.every(id => /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id)));
}
export function verifySkillCard(token: unknown, actor: CanvasActor, conversation: string): SkillCardClaim {
  if (typeof token !== "string" || token.length > 16000) throw Error("Invalid Skill card");
  const [raw, seal, extra] = token.split(".");
  if (extra !== undefined || !/^[a-f0-9]{64}$/.test(seal ?? "") || !timingSafeEqual(Buffer.from(sign(raw), "hex"), Buffer.from(seal, "hex"))) throw Error("Invalid Skill card");
  const claim = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as SkillCardClaim;
  const expected = binding(actor, conversation), now = Math.floor(Date.now() / 1000);
  if (!valid(claim) || claim.owner !== expected.owner || claim.bot !== expected.bot || claim.conversation !== expected.conversation ||
      !Number.isSafeInteger(claim.expires) || claim.expires < now || claim.expires > now + 660) throw Error("Expired or foreign Skill card");
  return claim;
}

export function skillSubmission(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string" && value.length <= 18000) { try { value = JSON.parse(value); } catch { return; } }
  const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  const root = object(value), action = object(root?.action);
  return [root, object(action?.data), object(root?.data)].find(v => v?.feature === "ac.skill");
}
