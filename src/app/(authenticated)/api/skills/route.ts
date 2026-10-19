import { createUserSkill, deleteUserSkill, getUserSkill, listUserSkills, updateUserSkill } from "@/features/skills/skill-service";
import { exportSkill } from "@/features/skills/skill-rules";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function failure(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Skillを操作できませんでした。";
  if (message === "User not found") return Response.json({error:"ログインが必要です。"},{status:401});
  return Response.json({error: error instanceof TypeError ? message : "Skillを操作できませんでした。"},{status:error instanceof TypeError ? 400 : 500});
}
async function body(request: Request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 60000) throw new TypeError("送信内容が大きすぎます。");
  try { const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new TypeError("送信内容が正しくありません。"); }
}
export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("download");
    if (id) return new Response(exportSkill(await getUserSkill(id)), {headers:{
      "Content-Type":"text/markdown; charset=utf-8", "Content-Disposition":'attachment; filename="skill.md"',
      "Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff",
    }});
    return Response.json({items:await listUserSkills()},{headers:{"Cache-Control":"private, no-store"}});
  } catch(error) {return failure(error);}
}
export async function POST(request: Request) {
  try { return Response.json({item:await createUserSkill(await body(request))},{status:201}); }
  catch(error) {return failure(error);}
}
export async function PUT(request: Request) {
  try { const value=await body(request); return Response.json({item:await updateUserSkill(value.id,value,value.version)}); }
  catch(error) {return failure(error);}
}
export async function DELETE(request: Request) {
  try { const value=await body(request); await deleteUserSkill(value.id,value.version); return Response.json({ok:true}); }
  catch(error) {return failure(error);}
}
