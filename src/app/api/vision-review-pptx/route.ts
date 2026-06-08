export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import { OpenAIVisionInstance } from "@/features/common/services/openai";

const execFileAsync = promisify(execFile);

const ALLOWED_SLIDE_FIELDS = new Set([
  "density",
  "textTreatment",
  "layoutType",
  "coverSubtitle",
  "subtitle",
  "title",
  "callout",
  "bullets",
  "steps",
  "deleteSlide",
  "regenerateStyle",
]);

export type VisionFix =
  | {
      slideIndex: number;
      field: "density" | "textTreatment" | "layoutType" | "coverSubtitle" | "subtitle";
      value: string;
      reason?: string;
    }
  | {
      slideIndex: number;
      field: "title";
      value: string; // スライドタイトルの修正
      reason?: string;
    }
  | {
      slideIndex: number;
      field: "callout";
      value: string; // "見出し|本文" パイプ区切り（3色結論バンド）
      reason?: string;
    }
  | {
      slideIndex: number;
      field: "bullets";
      value: string; // "bullet1|bullet2|bullet3" パイプ区切り
      reason?: string;
    }
  | {
      slideIndex: number;
      field: "steps";
      value: string; // "タイトル1:説明1|タイトル2:説明2" パイプ区切り
      reason?: string;
    }
  | {
      slideIndex: number;
      field: "deleteSlide";
      value: "true";
      reason?: string;
    }
  | {
      slideIndex: -1;
      field: "regenerateStyle";
      value: string; // "modern-dark recruitment" など自由記述のスタイルヒント
      reason?: string;
    }
  | {
      slideIndex: number;
      field: "metrics.colorRole";
      itemIndex: number;
      value: "primary" | "accent" | "neutral";
      reason?: string;
    };

export type VisionReviewResult = {
  deckScore: number;
  fixes: VisionFix[];
};

/** PromptIntent から Vision LLM へのインテントチェック指示を生成 */
function buildIntentChecks(intent: Record<string, unknown>): string[] {
  const checks: string[] = [];
  const ld = (intent.layoutDirectives ?? {}) as Record<string, unknown>;
  const cd = (intent.colorDirectives ?? {}) as Record<string, unknown>;
  const purpose = String(intent.documentPurpose ?? "");
  const audience = String(intent.audience ?? "");
  const freedom = String(intent.designFreedom ?? "");

  checks.push("\n=== INTENT COMPLIANCE CHECKS (evaluate these too) ===");

  if (ld.preferTwoColumn) checks.push("- User requested TWO-COLUMN layout. If no multi-column slide is visible, suggest layoutType='multi-column' for a suitable slide.");
  if (ld.includeTables)   checks.push("- User requested TABLES. If no table slide is visible, suggest layoutType='table' for a data-heavy slide.");
  if (ld.preferMetrics)   checks.push("- User requested METRICS/KPI emphasis. Flag if no metric-cards layout is present.");
  if (ld.preferProcess)   checks.push("- User requested PROCESS/FLOW emphasis. Flag if no process-cards or timeline is present.");
  if (ld.avoidBulletOnly) checks.push("- User wants to AVOID bullet-only slides. If 3+ consecutive bullet slides exist, suggest varying layouts.");

  if (cd.primary || cd.accent) {
    const colors = [cd.primary ? `primary=#${cd.primary}` : "", cd.accent ? `accent=#${cd.accent}` : ""].filter(Boolean).join(", ");
    checks.push(`- User specified COLORS: ${colors}. If the deck colors look mismatched, suggest regenerateStyle with these color names.`);
  }

  if ((purpose === "proposal" || purpose === "ir" || audience === "executive") && freedom !== "expressive") {
    checks.push("- This is a CONSERVATIVE deck (proposal/IR/executive). If it looks too flashy, playful, or low-contrast, flag it.");
  }
  if (purpose === "recruitment" || purpose === "campaign") {
    checks.push("- This is an EXPRESSIVE deck (recruitment/campaign). If it looks too plain/corporate/green, suggest regenerateStyle.");
  }

  return checks;
}

async function pptxToPngs(pptxBuffer: Buffer, maxSlides = 12): Promise<string[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-review-"));
  const pptxPath = path.join(tmpDir, "input.pptx");
  const pngDir = path.join(tmpDir, "pngs");

  try {
    fs.writeFileSync(pptxPath, pptxBuffer);
    fs.mkdirSync(pngDir, { recursive: true });

    const scriptCandidates = [
      path.join(process.cwd(), "src/scripts/pptx_to_png.py"),
      path.join(process.cwd(), "scripts/pptx_to_png.py"),
      "/home/site/wwwroot/src/scripts/pptx_to_png.py",
    ];
    const scriptPath = scriptCandidates.find((p) => fs.existsSync(p)) ?? scriptCandidates[0];
    const pythonPath = process.env.PYTHONPATH ?? "/home/site/python-packages";

    const { stdout, stderr } = await execFileAsync(
      "python3",
      [scriptPath, pptxPath, pngDir, String(maxSlides)],
      { env: { ...process.env, PYTHONPATH: pythonPath }, timeout: 90_000 }
    );

    if (stderr) {
      console.log(`[vision-review] pptx_to_png stderr: ${stderr.slice(0, 300)}`);
    }

    const pngList = stdout.replace(/\r/g, "").trim().split("\n").filter(Boolean);
    if (pngList.length === 0) {
      console.warn("[vision-review] No PNGs generated — converter not available");
    }
    return pngList;
  } catch (e) {
    console.error("[vision-review] pptxToPngs failed:", e);
    return [];
  }
}

async function reviewWithVision(
  pngPaths: string[],
  title: string,
  promptIntent?: Record<string, unknown>
): Promise<VisionReviewResult> {
  const openai = OpenAIVisionInstance();
  const model = process.env.AZURE_OPENAI_VISION_API_DEPLOYMENT_NAME!;

  // 全スライドをレビュー対象にする（上限 12枚 — 10枚資料は全ページカバー）
  const reviewPaths = pngPaths.slice(0, 12);

  const imageContents = reviewPaths.map((p) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`,
      detail: "auto" as const,  // モデルが解像度を自動判断（low固定より崩れ検出精度が高い）
    },
  }));

  const systemPrompt = [
    "You are a professional B2B presentation design reviewer specialized in Japanese corporate materials.",
    "Evaluate ALL slide images carefully on these criteria:",
    "1. Does the cover subtitle convey value to the viewer, not just echo the prompt?",
    "2. Is text density appropriate? Flag slides where text is cramped or cards are overfilled.",
    "3. Is whitespace sufficient? Flag slides that look cluttered or have large empty areas.",
    "4. Does each slide deliver exactly one message?",
    "5. Are accent colors used meaningfully, not randomly?",
    "6. Are there slides with almost no visible content (empty boxes, placeholder-only, or meaningless decorations)?",
    "7. Are process/step slides missing real step content?",
    "",
    "Return ONLY valid JSON in this exact shape:",
    '{"deckScore": <0-100>, "fixes": [<fix>, ...]}',
    "",
    "Each <fix> must be EXACTLY one of these forms:",
    '{"slideIndex":<n>, "field":"density", "value":"low"|"medium"|"high", "reason":"..."}',
    '{"slideIndex":<n>, "field":"textTreatment", "value":"short"|"normal"|"explanatory", "reason":"..."}',
    '{"slideIndex":<n>, "field":"layoutType", "value":"bullets"|"process-cards"|"table"|"multi-column", "reason":"..."}',
    '{"slideIndex":<n>, "field":"coverSubtitle", "value":"<60-char viewer-facing tagline>", "reason":"..."}',
    '{"slideIndex":<n>, "field":"title", "value":"<new slide title (≤25 chars)>", "reason":"..."}',
    '{"slideIndex":<n>, "field":"subtitle", "value":"<short subtitle>", "reason":"..."}',
    '{"slideIndex":<n>, "field":"callout", "value":"<heading (≤15 chars)>|<body (1-2 sentences)>", "reason":"..."}',
    '{"slideIndex":<n>, "field":"bullets", "value":"bullet1|bullet2|bullet3", "reason":"..."}',
    '{"slideIndex":<n>, "field":"steps", "value":"タイトル1:説明1|タイトル2:説明2", "reason":"..."}',
    '{"slideIndex":<n>, "field":"deleteSlide", "value":"true", "reason":"..."}',
    '{"slideIndex":<n>, "field":"metrics.colorRole", "itemIndex":<0-3>, "value":"primary"|"accent"|"neutral", "reason":"..."}',
    "",
    '{"slideIndex":-1, "field":"regenerateStyle", "value":"<style description>", "reason":"..."}',
    "",
    ...(promptIntent ? buildIntentChecks(promptIntent) : []),
    "IMPORTANT RULES:",
    "- slideIndex -1 means the cover/title slide (index 0 is the first content slide).",
    "- Use regenerateStyle when the OVERALL color scheme / visual style does not match the deck purpose (e.g. green corporate colors on a tech recruitment deck). value should describe desired direction in 3-10 words (e.g. 'modern dark tech recruitment indigo accent').",
    "- Use deleteSlide ONLY for slides that are genuinely empty or have no real content.",
    "- DENSITY RULES: density='low' means the slide is CRAMPED or OVERLOADED (too much text, too many card items, text is unreadable).",
    "  Do NOT use density='low' for slides with thin content, sparse information, or missing details.",
    "  For thin/sparse content: use density='high' (to show more items) OR add content via 'bullets' or 'callout'.",
    "- CALLOUT RULE: callout is a 3-color conclusion banner shown at the bottom of a content slide.",
    "  Each content slide should ideally have a callout with the slide's main conclusion, insight, or action.",
    "  If a slide lacks a strong conclusion block, add field='callout' with value='<heading>|<body>'.",
    "  heading: key point in ≤15 chars. body: 1-2 sentences of impact/evidence/action.",
    "  Example: {\"slideIndex\":2, \"field\":\"callout\", \"value\":\"導入効果|コスト30%削減・生産性2倍を3ヶ月で実現\", \"reason\":\"結論ブロックがない\"}",
    "- Use title to correct a slide title that is misleading, too long (>25 chars), or unclear.",
    "- Use bullets to rewrite slide content when current bullets are too long, missing, or off-topic.",
    "- Use steps to rewrite process step content when steps are missing or empty.",
    "- bullets value: pipe-separated list of bullet strings (e.g. 'Point A|Point B|Point C').",
    "- steps value: pipe-separated 'title:body' pairs (e.g. 'Step1:Desc1|Step2:Desc2').",
    "- Only include fixes for real problems. Do NOT fix slides that look good.",
    "Return no other text — JSON only.",
  ].join("\n");

  console.log(`[vision-review] model=${model} slides=${reviewPaths.length}`);

  const res = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Presentation title: "${title}"\nReview the first ${reviewPaths.length} slides:`,
          },
          ...imageContents,
        ],
      },
    ],
    max_completion_tokens: 4000,
  });

  const choice = res.choices[0];
  console.log(`[vision-review] finish_reason=${choice?.finish_reason} usage=${JSON.stringify(res.usage)}`);

  const raw = choice?.message?.content ?? "";
  console.log(`[vision-review] raw response: ${raw.slice(0, 300)}`);

  if (!raw.trim()) {
    console.warn("[vision-review] empty response — model may not support image input");
    return { deckScore: 0, fixes: [] };
  }

  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]).trim() : raw.trim();

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn(`[vision-review] JSON parse failed, raw: ${raw.slice(0, 200)}`);
    return { deckScore: 0, fixes: [] };
  }

  const rawFixes: any[] = Array.isArray(parsed.fixes) ? parsed.fixes : [];
  const validFixes: VisionFix[] = rawFixes.filter((f) => {
    if (typeof f.slideIndex !== "number" || typeof f.field !== "string") return false;
    if (f.field === "metrics.colorRole") {
      return typeof f.itemIndex === "number" && ["primary", "accent", "neutral"].includes(f.value);
    }
    if (f.field === "deleteSlide") {
      return f.value === "true";
    }
    if (f.field === "regenerateStyle") {
      return f.slideIndex === -1 && typeof f.value === "string" && f.value.trim().length > 0;
    }
    if (f.field === "bullets" || f.field === "steps") {
      // パイプ区切り文字列で中身があること
      return typeof f.value === "string" && f.value.trim().length > 0;
    }
    if (f.field === "callout") {
      // "見出し|本文" 形式でパイプが含まれること
      return typeof f.value === "string" && f.value.includes("|") && f.value.trim().length > 2;
    }
    if (f.field === "title") {
      return typeof f.value === "string" && f.value.trim().length > 0 && f.value.trim().length <= 40;
    }
    return ALLOWED_SLIDE_FIELDS.has(f.field) && typeof f.value === "string";
  });

  console.log(`[vision-review] fixes accepted=${validFixes.length} / raw=${rawFixes.length}`);

  return {
    deckScore: typeof parsed.deckScore === "number" ? parsed.deckScore : 0,
    fixes: validFixes,
  };
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const pptxBlob = formData.get("pptx") as Blob | null;
    const title = String(formData.get("title") ?? "");

    if (!pptxBlob) {
      return NextResponse.json({ error: "pptx is required" }, { status: 400 });
    }

    const pptxBuffer = Buffer.from(await pptxBlob.arrayBuffer());
    console.log(`[vision-review] pptx size=${pptxBuffer.length} title="${title}"`);

    // PromptIntent を取得（gen-pptx から JSON 文字列で渡される）
    const intentRaw = formData.get("promptIntent");
    let promptIntent: Record<string, unknown> | undefined;
    if (typeof intentRaw === "string") {
      try { promptIntent = JSON.parse(intentRaw); } catch {}
    }
    if (promptIntent) {
      console.log(`[vision-review] intentCheck purpose=${promptIntent.documentPurpose} freedom=${promptIntent.designFreedom}`);
    }

    const pngPaths = await pptxToPngs(pptxBuffer, 12);
    if (pngPaths.length === 0) {
      return NextResponse.json({ deckScore: 0, fixes: [] });
    }

    console.log(`[vision-review] Reviewing ${pngPaths.length} slides with Vision LLM`);
    const result = await reviewWithVision(pngPaths, title, promptIntent);
    console.log(`[vision-review] deckScore=${result.deckScore} fixes=${result.fixes.length}`);

    pngPaths.forEach((p) => { try { fs.unlinkSync(p); } catch {} });

    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[vision-review] error (non-fatal):", String(e?.message ?? e).slice(0, 200));
    return NextResponse.json({ deckScore: 0, fixes: [] });
  }
}
