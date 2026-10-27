import { getCurrentUser } from "@/features/auth-page/helpers";
import { skillBytes } from "@/features/skills/skill-rules";
import { similarCandidates, validateGeneratorInput, type GeneratorCandidate } from "@/features/skills/skill-generator-rules";
import { generateSkillTurn } from "@/features/skills/skill-generator-service";
import { listSharedSkills, listUserSkills } from "@/features/skills/skill-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 80000;

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
      if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw new TypeError("入力が大きすぎます。"); }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new TypeError("入力形式が正しくありません。"); }
    if (skillBytes(text) > MAX_REQUEST_BYTES) throw new TypeError("入力が大きすぎます。");
    const input = validateGeneratorInput(body);
    // Catalog is read server-side for the signed-in user; client-supplied Skills are never trusted.
    const own = await listUserSkills();
    const shared = await listSharedSkills().catch(() => []);
    const catalog: GeneratorCandidate[] = [
      ...own.map(skill => ({ ref: skill.id, scope: "own" as const, title: skill.title, description: skill.description, content: skill.content })),
      ...shared.map(skill => ({ ref: `shared-${skill.ref}`, scope: "shared" as const, title: skill.title, description: skill.description, content: skill.content, ownerName: skill.ownerName })),
    ];
    const requestText = [...input.messages.filter(message => message.role === "user").map(message => message.content), input.draft?.title ?? ""].join("\n");
    const pinned = !input.createNew && input.basedOn ? catalog.find(skill => skill.ref === input.basedOn!.ref && skill.scope === input.basedOn!.scope) : undefined;
    if (!input.createNew && input.basedOn && (!pinned || (pinned.scope === "own" && own.find(skill => skill.id === pinned.ref)?.version !== input.basedOn.version))) {
      return Response.json({ error: "更新元のSkillが変更または削除されました。内容を確認してから作成し直してください。" }, { status: 409 });
    }
    const candidates = pinned ? [pinned] : input.createNew ? [] : similarCandidates(requestText, catalog);
    // Generation does not write to Skills, chat history or automatic memory.
    const turn = await generateSkillTurn(input, { email: user.email, catalog, candidates }, request.signal);
    const base = pinned ?? turn.basedOn;
    const ownBase = base?.scope === "own" ? own.find(skill => skill.id === base.ref) : undefined;
    return Response.json({
      reply: turn.reply,
      ...(turn.draft ? { draft: turn.draft } : {}),
      ...(base ? { basedOn: { ref: base.ref, scope: base.scope, title: base.title, ...(base.ownerName ? { ownerName: base.ownerName } : {}),
        ...(ownBase ? { id: ownBase.id, version: input.basedOn?.version ?? ownBase.version, shared: ownBase.shared === true } : {}) } } : {}),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "User not found") return Response.json({ error: "ログインが必要です。" }, { status: 401 });
    if (error instanceof TypeError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof Error && error.message === "generator_not_configured") return Response.json({ error: "生成AIの接続設定がありません。本文を手入力する方法でもSkillを作成できます。" }, { status: 503 });
    // Do not log or return private messages, prompts, model responses or upstream details.
    return Response.json({ error: "うまく応答を作れませんでした。入力内容はそのまま残っています。もう一度送信してください。" }, { status: 503 });
  }
}
