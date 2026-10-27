import { listAvailableSkills } from "@/features/skills/skill-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const items = (await listAvailableSkills()).filter(s => s.enabled).map(({ id, title, description, enabled, version, scope, ownerName }) => ({ id, title, description, enabled, version, scope: scope ?? "own", ...(ownerName ? { ownerName } : {}) }));
    return Response.json({ items }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ items: [] }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
}
