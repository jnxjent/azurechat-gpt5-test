"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { GENERATOR_MAX_MESSAGES, GENERATOR_USER_MESSAGE_BYTES, generatorOpening, retainGeneratorBase, type GeneratorBase, type GeneratorMessage } from "./skill-generator-rules";
import { skillBytes, validateSkill } from "./skill-rules";
import type { SharedSkill, SkillInput, UserSkill } from "./skill-rules";

type BasedOn = GeneratorBase;

export function SkillGenerator(props: { skills: UserSkill[]; shared: SharedSkill[]; onApply: (draft: SkillInput, baseId?: string, baseVersion?: number) => void; onSaved: (skill: UserSkill) => void; onClose: () => void }) {
  const opening = useMemo(() => generatorOpening([...props.skills.map(skill => skill.title), ...props.shared.map(skill => skill.title)], props.skills.length + props.shared.length), [props.skills, props.shared]);
  const [messages, setMessages] = useState<GeneratorMessage[]>([{ role: "assistant", content: opening }]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<SkillInput | null>(null);
  const [basedOn, setBasedOn] = useState<BasedOn | null>(null);
  const [publish, setPublish] = useState(false);
  const [createNew, setCreateNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: "nearest" }); }, [messages, busy]);
  const bytes = skillBytes(input.trim());
  const full = messages.length + 2 > GENERATOR_MAX_MESSAGES;

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy || saving || bytes > GENERATOR_USER_MESSAGE_BYTES || full) return;
    const previous = messages, next: GeneratorMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next); setInput(""); setError("");
    const requestController = new AbortController(); controller.current = requestController;
    setBusy(true);
    try {
      const response = await fetch("/api/skills/generate", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: requestController.signal,
        body: JSON.stringify({ messages: next, ...(draft ? { draft } : {}), ...(basedOn ? { basedOn } : {}), createNew }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "応答を作れませんでした。");
      if (requestController.signal.aborted) return;
      setMessages([...next, { role: "assistant", content: String(data.reply ?? "") }]);
      if (data.draft) {
        setDraft(validateSkill(data.draft));
        const retained = retainGeneratorBase(basedOn, data.basedOn, publish, createNew);
        setBasedOn(retained.basedOn); setPublish(retained.publish);
      }
    } catch (cause) {
      if (requestController.signal.aborted) return;
      // Restore the unsent text so the user can simply resend it.
      setMessages(previous); setInput(text);
      setError(cause instanceof Error ? cause.message : "応答を作れませんでした。もう一度お試しください。");
    } finally { if (!requestController.signal.aborted) { setBusy(false); requestAnimationFrame(() => inputRef.current?.focus()); } }
  }

  async function save(mode: "create" | "update") {
    if (!draft || busy || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const update = mode === "update" && basedOn?.scope === "own" && basedOn.id;
      const response = await fetch("/api/skills", {
        method: update ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, shared: publish, ...(update ? { id: basedOn!.id, version: basedOn!.version } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存できませんでした。もう一度お試しください。");
      props.onSaved(data.item);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存できませんでした。"); }
    finally { savingRef.current = false; setSaving(false); }
  }

  function close() {
    if ((messages.length > 1 || input || draft) && !window.confirm("作成中の内容を破棄して閉じますか？")) return;
    controller.current?.abort(); props.onClose();
  }

  const updatesOwn = basedOn?.scope === "own" && !!basedOn.id;
  return <section aria-label="SkillGenerator" className="min-w-0 space-y-4 rounded border p-4 md:p-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">AIとSkillを作成</h2><button type="button" disabled={saving} onClick={close} className="rounded border px-3 py-1 text-sm disabled:opacity-50">閉じる</button></div>
    <div aria-label="Skill作成の会話" aria-live="polite" className="max-h-[26rem] space-y-3 overflow-y-auto rounded border bg-muted/30 p-3">
      {messages.map((message, index) => <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
        <p className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg p-3 text-sm ${message.role === "user" ? "bg-primary text-primary-foreground" : "border bg-background"}`}>{message.content}</p>
      </div>)}
      {busy && <p role="status" className="text-sm text-muted-foreground">考えています…</p>}
      <div ref={transcriptEnd} />
    </div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <form onSubmit={send} className="space-y-2">
      <label htmlFor="generator-input" className="sr-only">メッセージ</label>
      <textarea id="generator-input" ref={inputRef} value={input} disabled={busy || saving || full} maxLength={2000}
        onChange={event => setInput(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }}
        placeholder={draft ? "変えたい点を自由に書いてください（例：結果を表形式にして、最後に未確認事項をまとめて）" : "作りたいスキルを、思いつくまま書いてください"}
        className="min-h-24 w-full rounded border bg-background p-3 text-sm disabled:opacity-60" />
      {bytes > GENERATOR_USER_MESSAGE_BYTES && <p role="alert" className="text-sm text-red-600">1回の入力は2,000バイト以内にしてください。</p>}
      {full && <p className="text-sm text-muted-foreground">会話が長くなりました。今の案を保存するか、「編集してから保存」で仕上げてください。</p>}
      <div className="flex items-center gap-3"><button type="submit" disabled={busy || saving || !input.trim() || bytes > GENERATOR_USER_MESSAGE_BYTES || full} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">送信</button><span className="text-xs text-muted-foreground">Ctrl+Enterでも送信できます</span></div>
    </form>
    {draft && <div aria-label="生成したSkill案" className="space-y-3 rounded border p-3">
      <h3 className="font-semibold">Skill案：{draft.title}</h3>
      {draft.description && <p className="text-sm text-muted-foreground">{draft.description}</p>}
      {basedOn && <p className="text-xs text-muted-foreground">{basedOn.scope === "own" ? `既存のSkill「${basedOn.title}」をもとにした改善案です。` : `${basedOn.ownerName ?? "他の社員"}さんの公開Skill「${basedOn.title}」をもとにした改善案です。あなたのSkillとして保存され、元のSkillは変わりません。`}</p>}
      {basedOn && <button type="button" disabled={busy || saving} onClick={() => { setBasedOn(null); setCreateNew(true); setPublish(false); }} className="rounded border px-3 py-1 text-sm">更新元を外して新しく作る</button>}
      <details><summary className="cursor-pointer text-sm">プロンプト本文を表示</summary>
        <pre aria-label="生成したプロンプト案" className="mt-2 max-h-[24rem] overflow-y-auto whitespace-pre-wrap break-words rounded border bg-background p-3 font-mono text-sm">{draft.content}</pre>
      </details>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={publish} disabled={saving} onChange={event => setPublish(event.target.checked)} />全社に公開する（他の社員が閲覧・コピーできます）</label>
      <div className="flex flex-wrap gap-2">
        {updatesOwn && <button type="button" disabled={busy || saving} onClick={() => void save("update")} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{saving ? "保存中…" : `「${basedOn!.title}」を更新`}</button>}
        <button type="button" disabled={busy || saving} onClick={() => void save("create")} className={updatesOwn ? "rounded border px-3 py-2 disabled:opacity-50" : "rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"}>{saving && !updatesOwn ? "保存中…" : updatesOwn ? "新しいSkillとして保存" : "Skillsに保存"}</button>
        <button type="button" disabled={busy || saving} onClick={() => props.onApply({ ...draft, shared: publish }, updatesOwn ? basedOn!.id : undefined, updatesOwn ? basedOn!.version : undefined)} className="rounded border px-3 py-2 disabled:opacity-50">編集してから保存</button>
      </div>
    </div>}
  </section>;
}
