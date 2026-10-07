import "server-only";
import { OpenAIInstance } from "@/features/common/services/openai";
import { findNamedMemories, normalizeMemoryName, selectMemories } from "./memory-rules";
import type { MemoryMode, UserMemory } from "./memory-rules";

const SECRET_PATTERN = /(?:password|passwd|api[ _-]?key|secret|token|credential|パスワード|暗証番号|認証情報|秘密鍵)/i;
const PROFILE_PATTERN = /(?:私は|わたしは|ユーザー(?:の)?(?:属性|情報)|プロフィール|氏名|名前|表示名|所属|部署|部門|役職|職位|勤務時間|勤務地|拠点|希望する|好み|優先|使用言語|タイムゾーン)/i;

export type PreparedMemory = {
  mode: MemoryMode;
  memoryClass: "profile" | "reference";
  profileSummary?: string;
};

function compactProfile(content: string): string {
  const candidates = content
    .split(/\r?\n|(?<=[。！？])/)
    .map((line) => line.replace(/^[-*#\s]+/, "").trim())
    .filter((line) => line && PROFILE_PATTERN.test(line) && !SECRET_PATTERN.test(line));
  return Array.from(new Set(candidates)).slice(0, 12).join("\n").slice(0, 800);
}

function configured(): boolean {
  return Boolean(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME &&
    (process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_API_INSTANCE_NAME));
}

function jsonObject(text: string | null | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try { return JSON.parse(text) as Record<string, unknown>; } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try { return JSON.parse(match[0]) as Record<string, unknown>; } catch { return undefined; }
  }
}

export async function prepareMemoryClassification(title: string, content: string, requestedMode: MemoryMode): Promise<PreparedMemory> {
  const fallbackSummary = compactProfile(`${title}\n${content}`);
  if (!configured()) {
    return fallbackSummary
      ? { mode: "required", memoryClass: "profile", profileSummary: fallbackSummary }
      : { mode: requestedMode === "required" ? "manual" : requestedMode, memoryClass: "reference" };
  }
  try {
    const result = await OpenAIInstance().chat.completions.create({
      model: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME ?? "",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "保存メモを分類する。個人の氏名、所属、役職、勤務地、勤務時間、言語、安定した好みだけをprofileとする。業務手順、案件情報、一時的な依頼、認証情報はprofileにしない。JSONのみ返す: {\"memoryClass\":\"profile|reference\",\"profileSummary\":\"profileの場合だけ、秘密情報を除いた800文字以内の最小限の箇条書き\"}" },
        { role: "user", content: `保存名: ${title}\n本文:\n${content.slice(0, 6000)}` },
      ],
    });
    const parsed = jsonObject(result.choices[0]?.message?.content);
    if (parsed?.memoryClass === "profile") {
      const summary = typeof parsed.profileSummary === "string" ? parsed.profileSummary.trim().slice(0, 800) : fallbackSummary;
      if (summary && !SECRET_PATTERN.test(summary)) return { mode: "required", memoryClass: "profile", profileSummary: summary };
    }
  } catch (error) {
    console.warn("[memory] profile classification failed; deterministic fallback is used", error);
  }
  return fallbackSummary
    ? { mode: "required", memoryClass: "profile", profileSummary: fallbackSummary }
    : { mode: requestedMode === "required" ? "manual" : requestedMode, memoryClass: "reference" };
}

export type MemoryRelevanceResolution = {
  selected: UserMemory[];
  uncertain?: { memory: UserMemory; evidence: string };
};

function grams(value: string): Set<string> {
  const normalized = normalizeMemoryName(value);
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index++) result.add(normalized.slice(index, index + 2));
  return result;
}

function overlapScore(memory: UserMemory, message: string): number {
  const query = grams(message);
  if (!query.size) return 0;
  const target = grams(`${memory.title}\n${memory.triggers.join(" ")}\n${memory.content.slice(0, 1200)}`);
  let common = 0;
  query.forEach((term) => { if (target.has(term)) common++; });
  return common / query.size;
}

export async function resolveMemoryRelevance(memories: UserMemory[], message: string): Promise<MemoryRelevanceResolution> {
  const base = selectMemories(memories, message);
  const profileQuestion = /(?:私|わたし|自分|利用者|ユーザー)(?:が)?(?:の)?(?:プロフィール|属性|所属|担当|役職|入社|勤務|業務)|(?:プロフィール|ユーザー属性|利用者属性)(?:情報)?(?:を)?(?:教えて|見せて|確認)/i.test(message);
  if (profileQuestion) {
    return { selected: base.filter((memory) => memory.memoryClass === "profile" || memory.mode === "always") };
  }
  // Save requests must not be diverted to a similarly worded existing memo.
  if (/(?:メモ|保存|保管|記録|覚えて).*(?:して|しておいて)|(?:メモしておいて|覚えておいて)/i.test(message)) {
    return { selected: base };
  }
  const baseIds = new Set(base.map((item) => item.id));
  const manual = memories.filter((item) => item.enabled && item.mode === "manual" && !baseIds.has(item.id));
  const candidates = manual.map((memory) => ({ memory, score: overlapScore(memory, message) }))
    .filter((item) => item.score >= 0.14).sort((a, b) => b.score - a.score).slice(0, 6);
  if (!candidates.length) return { selected: base };

  if (configured()) {
    try {
      const result = await OpenAIInstance().chat.completions.create({
        model: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME ?? "",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "ユーザー依頼と保存メモの関連性を判定する。highはメモが依頼へ直接適用できる場合、uncertainは似ているが適用条件が不明な場合、lowは不要な場合。JSONのみ: {\"decisions\":[{\"id\":\"...\",\"relevance\":\"high|uncertain|low\",\"evidence\":\"メモ記載の短い要点\"}]}" },
          { role: "user", content: `依頼:\n${message.slice(0, 2000)}\n\n候補メモ:\n${candidates.map(({ memory }) => `[${memory.id}] ${memory.title}\n${memory.content.slice(0, 700)}`).join("\n\n")}` },
        ],
      });
      const parsed = jsonObject(result.choices[0]?.message?.content);
      const decisions = Array.isArray(parsed?.decisions) ? parsed.decisions as Array<Record<string, unknown>> : [];
      const highIds = new Set(decisions.filter((item) => item.relevance === "high").map((item) => String(item.id)));
      const selected = [...base, ...candidates.filter(({ memory }) => highIds.has(memory.id)).map(({ memory }) => memory)];
      const uncertainDecision = decisions.find((item) => item.relevance === "uncertain");
      const uncertainMemory = uncertainDecision && candidates.find(({ memory }) => memory.id === String(uncertainDecision.id))?.memory;
      return uncertainMemory ? { selected, uncertain: { memory: uncertainMemory,
        evidence: String(uncertainDecision.evidence ?? uncertainMemory.content.slice(0, 120)).trim() } } : { selected };
    } catch (error) {
      console.warn("[memory] relevance classification failed; explicit and mandatory references are retained", error);
    }
  }

  // Character overlap is only a candidate shortlist, not evidence that a memo
  // applies. If semantic classification is unavailable, keep explicit and
  // mandatory references without interrupting the user's unrelated request.
  return { selected: base };
}

export function findConfirmedMemory(memories: UserMemory[], assistantMessage: string): UserMemory | undefined {
  const title = assistantMessage.match(/メモ「([^」]+)」には/)?.[1];
  return title ? findNamedMemories(memories.filter((item) => item.enabled), title)[0] : undefined;
}
