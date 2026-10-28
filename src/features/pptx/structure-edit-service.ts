import "server-only";
import { OpenAIPptInstance } from "@/features/common/services/openai";
import { FindTopChatMessagesForCurrentUser } from "@/features/chat-page/chat-services/chat-message-service";
import {
  type PptxStructureContent,
  type PptxStructureIntent,
  type PptxStructureOp,
  MAX_ADDED_SLIDES,
  verifyPptxStructureContent,
} from "./structure-edit-intent";

type EditResult = { downloadUrl: string; fileName: string; displayName: string; message: string } | { error: string };
const SOURCE_CHARS = 16_000;

/** Recent assistant answers and tool results in this thread, newest first. */
async function loadThreadSource(threadId: string): Promise<string> {
  const found = await FindTopChatMessagesForCurrentUser(threadId, 12);
  if (found.status !== "OK") return "";
  const parts: string[] = [];
  let assistants = 0;
  for (const message of found.response) {
    if (message.role === "assistant" && message.content?.trim()) {
      if (assistants >= 3) continue;
      assistants++;
      parts.push(message.content);
    } else if (message.role === "tool" && message.content?.trim()) {
      parts.push(message.content);
    }
  }
  return parts.join("\n\n---\n\n").slice(0, SOURCE_CHARS);
}

async function buildSlideContents(instruction: string, source: string, count: number): Promise<{ slides: PptxStructureContent[]; error?: string }> {
  const model = process.env.AZURE_OPENAI_PPT_DEPLOYMENT_NAME?.trim() || process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME?.trim() || "";
  const completion = await OpenAIPptInstance().chat.completions.create({
    model,
    max_completion_tokens: 4000,
    response_format: { type: "json_object" } as const,
    messages: [
      {
        role: "system",
        content:
          "You turn chat content into slide content for an existing PowerPoint deck. Output JSON only: " +
          '{"slides":[{"title":string,"kind":"bullets"|"table","bullets"?:string[],"table"?:{"columns":string[],"rows":string[][]},"sources"?:[{"label":string,"url":string}]}],"error":string|null}. ' +
          `Return at most ${count} slide(s). Use ONLY facts in SOURCE or in the user's request. Copy company names, numbers and units exactly as written; never estimate, convert or add facts. ` +
          "Use kind=table when comparing several items (max 5 columns, 6 rows); otherwise bullets (max 6, each under 60 Japanese characters). Title under 30 characters, in Japanese. " +
          "sources: only URLs that appear verbatim in SOURCE and support the slide. " +
          "If the request does not identify which content to use, or SOURCE lacks it, return slides:[] and error explaining what is missing.",
      },
      { role: "user", content: `REQUEST:\n${instruction}\n\nSOURCE (recent chat answers and search results, newest first):\n${source || "(none)"}` },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "";
  try {
    const parsed = JSON.parse(raw) as { slides?: unknown; error?: unknown };
    const slides = Array.isArray(parsed.slides) ? (parsed.slides as PptxStructureContent[]).slice(0, count) : [];
    return { slides, ...(typeof parsed.error === "string" && parsed.error.trim() ? { error: parsed.error.trim() } : {}) };
  } catch {
    return { slides: [], error: "スライド内容を作成できませんでした。" };
  }
}

export async function executePptxStructureEdit(props: {
  intent: PptxStructureIntent;
  instruction: string;
  fileUrl: string;
  threadId: string;
  baseUrl: string;
  outputBaseName: string;
}): Promise<EditResult> {
  const { intent } = props;
  const notes: string[] = [];
  let ops: PptxStructureOp[] = [];

  if (intent.kind === "font_size") {
    ops = [{ type: "font_size", scope: intent.scope, mode: intent.mode, value: intent.value, ...(intent.slides ? { slides: intent.slides } : {}) }];
  } else if (intent.kind === "add_slide" && intent.blank) {
    ops = Array.from({ length: intent.count }, (_, i) => ({
      type: "add_slide" as const, blank: true, title: "",
      ...(intent.position !== undefined ? { position: intent.position >= 0 ? intent.position + i : intent.position } : {}),
    }));
  } else {
    const count = intent.kind === "add_slide" ? intent.count : 1;
    const source = await loadThreadSource(props.threadId).catch(() => "");
    const built = await buildSlideContents(props.instruction, source, count);
    const verified = verifyPptxStructureContent(built.slides, `${props.instruction}\n${source}`);
    notes.push(...verified.warnings);
    if (!verified.slides.length) {
      return { error: built.error ? `スライドを追加できませんでした: ${built.error}` : "どの回答の内容を入れるか特定できませんでした。入れたい内容や対象の回答を指定してください。PPTXは変更していません。" };
    }
    ops = intent.kind === "fill_slide"
      ? [{ type: "fill_slide", slideIndex: intent.slideIndex, ...verified.slides[0] }]
      : verified.slides.map((content, i) => ({
          type: "add_slide" as const, ...content,
          ...(intent.position !== undefined ? { position: intent.position >= 0 ? intent.position + i : intent.position } : {}),
        }));
  }
  if (intent.kind === "add_slide" && intent.requestedCount > MAX_ADDED_SLIDES) {
    notes.push(`1回の依頼で追加できるのは${MAX_ADDED_SLIDES}枚までのため、${MAX_ADDED_SLIDES}枚を追加しました。`);
  }

  const res = await fetch(`${props.baseUrl}/api/edit-pptx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "pptx_structure_edit",
      fileUrl: props.fileUrl,
      instruction: props.instruction,
      threadId: props.threadId,
      outputBaseName: props.outputBaseName,
      structureOps: ops,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok !== true || typeof json.downloadUrl !== "string") {
    return { error: `PPTの編集に失敗しました: ${String(json.error ?? `HTTP ${res.status}`)}。PPTXは変更していません。` };
  }
  const changed = Array.isArray(json.changedSlideIndices) ? (json.changedSlideIndices as number[]).map((i) => `P${i + 1}`).join("、") : "";
  const summary = intent.kind === "font_size"
    ? `フォントサイズを変更しました${changed ? `（${changed}）` : ""}。`
    : intent.kind === "fill_slide"
    ? `P${intent.slideIndex + 1}に本文を書き込みました。`
    : `スライドを追加しました${changed ? `（${changed}）` : ""}。全${json.totalSlides}枚です。`;
  const warnings = [
    ...notes,
    ...(Array.isArray(json.layoutWarnings) ? (json.layoutWarnings as string[]) : []),
    ...(Array.isArray(json.visualWarnings) ? (json.visualWarnings as string[]) : []),
  ];
  const unsupported = intent.unsupported.length ? `\n⚠ 未対応のため実行していません: ${intent.unsupported.join("、")}` : "";
  const displayName = `${props.outputBaseName}.pptx`;
  return {
    downloadUrl: json.downloadUrl,
    fileName: typeof json.fileName === "string" ? json.fileName : displayName,
    displayName,
    message: summary + warnings.map((w) => `\n⚠ ${w}`).join("") + unsupported,
  };
}
