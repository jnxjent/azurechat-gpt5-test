import { createUserMemory, deleteUserMemory, listUserMemories, updateUserMemory } from "@/features/memory/memory-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  const message = error instanceof Error ? error.message : "メモを操作できませんでした。";
  if (message === "User not found") return Response.json({ error: "ログインが必要です。" }, { status: 401 });
  return Response.json({ error: message }, { status: error instanceof TypeError ? 400 : 500 });
}

export async function GET() {
  try { return Response.json({ items: await listUserMemories() }); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try { return Response.json({ item: await createUserMemory(await request.json()) }, { status: 201 }); }
  catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    if (typeof body.id !== "string" || !Number.isInteger(body.version)) throw new TypeError("メモの版が正しくありません。");
    return Response.json({ item: await updateUserMemory(body.id, body, body.version) });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    if (typeof body.id !== "string") throw new TypeError("メモを指定してください。");
    await deleteUserMemory(body.id);
    return Response.json({ ok: true });
  } catch (error) { return failure(error); }
}
