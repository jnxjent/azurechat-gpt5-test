import { getCurrentUser } from "@/features/auth-page/helpers";
import { skillBytes } from "@/features/skills/skill-rules";
import { validateGeneratorInput } from "@/features/skills/skill-generator-rules";
import { generateSkillDraft } from "@/features/skills/skill-generator-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await getCurrentUser();
    // Bound streamed input too; do not trust Content-Length alone.
    const reader = request.body?.getReader();
    if (!reader) throw new TypeError("入力がありません。");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 32000) { await reader.cancel(); throw new TypeError("入力が大きすぎます。"); }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new TypeError("入力形式が正しくありません。"); }
    if (skillBytes(text) > 32000) throw new TypeError("入力が大きすぎます。");
    const input = validateGeneratorInput(body);
    // Generation does not write to Skills, chat history or automatic memory.
    const draft = await generateSkillDraft(input, user.email, request.signal);
    return Response.json({ draft }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "User not found") return Response.json({ error: "ログインが必要です。" }, { status: 401 });
    if (error instanceof TypeError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof Error && error.message === "generator_not_configured") return Response.json({ error: "生成AIの接続設定がありません。本文を手入力する方法でもSkillを作成できます。" }, { status: 503 });
    // Do not log or return private answers, prompts, model responses or upstream details.
    return Response.json({ error: "Skill案を生成できませんでした。回答はそのまま残っています。もう一度お試しください。" }, { status: 503 });
  }
}
