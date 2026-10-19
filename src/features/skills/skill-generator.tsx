"use client";
import { useEffect, useRef, useState } from "react";
import { combineGeneratorAnswer, GENERATOR_QUESTIONS, toggleGeneratorOption } from "./skill-generator-rules";
import { skillBytes, validateSkill } from "./skill-rules";
import type { SkillInput, UserSkill } from "./skill-rules";

export function SkillGenerator(props: { onApply: (draft: SkillInput) => void; onSaved: (skill: UserSkill) => void; onClose: () => void }) {
  const [answers, setAnswers] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [selectedOptions,setSelectedOptions] = useState<string[]>([]);
  const [answerForms,setAnswerForms] = useState<Array<{options:string[];input:string}>>([]);
  const [draft, setDraft] = useState<SkillInput | null>(null);
  const [revision, setRevision] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const answerInput = useRef<HTMLTextAreaElement>(null);
  const draftStart = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(()=>{if(draft)draftStart.current?.scrollIntoView({block:"start"});},[draft]);
  const question = GENERATOR_QUESTIONS[answers.length];
  const combinedAnswer = combineGeneratorAnswer(selectedOptions,input);
  async function saveDraft() {
    if (!draft || busy || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const response = await fetch("/api/skills", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存できませんでした。もう一度お試しください。");
      props.onSaved(data.item);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存できませんでした。"); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function generate(nextAnswers: string[], change?: string) {
    const requestController = new AbortController(); controller.current = requestController;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/skills/generate", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: requestController.signal,
        body: JSON.stringify({ answers: nextAnswers, ...(change && draft ? { draft, revision: change } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Skill案を生成できませんでした。");
      if (!requestController.signal.aborted) { setDraft(validateSkill(data.draft)); setRevision(""); }
    } catch (cause) {
      if (!requestController.signal.aborted) setError(cause instanceof Error ? cause.message : "生成できませんでした。もう一度お試しください。");
    } finally { if (!requestController.signal.aborted) setBusy(false); }
  }
  function answer(event: React.FormEvent) {
    event.preventDefault();
    if (!combinedAnswer || skillBytes(combinedAnswer) > 1200) return;
    if (!answers.length && /^(?:おまかせ|わからない|不明)$/.test(combinedAnswer)) { setError("最初に、作りたいSkillの目的を教えてください。"); return; }
    const next = [...answers, combinedAnswer]; setAnswers(next);
    setAnswerForms([...answerForms,{options:selectedOptions,input}]);setSelectedOptions([]);setInput("");setError("");
    if (next.length === GENERATOR_QUESTIONS.length) void generate(next);
    else requestAnimationFrame(() => answerInput.current?.focus());
  }
  function back() {
    const previous=answerForms[answerForms.length-1];
    setDraft(null);setError("");setInput(previous?.input??"");setSelectedOptions(previous?.options??[]);
    setAnswerForms(answerForms.slice(0,-1));setAnswers(answers.slice(0,-1));
    requestAnimationFrame(() => answerInput.current?.focus());
  }
  function close() {
    if ((answers.length || input || selectedOptions.length || draft) && !window.confirm("作成中の内容を破棄して閉じますか？")) return;
    controller.current?.abort(); props.onClose();
  }
  return <section aria-label="SkillGenerator" className="min-w-0 space-y-4 rounded border p-4 md:p-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">AIとSkillを作成</h2><button type="button" disabled={saving} onClick={close} className="rounded border px-3 py-1 text-sm disabled:opacity-50">閉じる</button></div>
    <p className="text-sm text-muted-foreground">5つの質問からプロンプト案を作ります。内容を確認したら、ボタン一つでSkillsに保存できます。</p>
    {draft&&<div ref={draftStart} className="sticky top-0 z-10 flex scroll-mt-2 flex-wrap gap-2 rounded border bg-background p-3" aria-label="生成したSkillの保存操作">
      <button type="button" disabled={busy||saving} onClick={()=>void saveDraft()} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{saving?"保存中…":"Skillsに保存"}</button>
      <button type="button" disabled={busy||saving} onClick={()=>props.onApply(draft)} className="rounded border px-3 py-2 disabled:opacity-50">編集してから保存</button>
      <button type="button" disabled={busy||saving} onClick={back} className="rounded border px-3 py-2 disabled:opacity-50">回答を見直す</button>
    </div>}
    {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
    {draft&&<p className="text-xs text-muted-foreground">内容を確認し、上の「Skillsに保存」で登録できます。</p>}
    <details open={draft?undefined:true}><summary className="cursor-pointer text-sm text-muted-foreground">これまでの回答（{answers.length}/{GENERATOR_QUESTIONS.length}）</summary>
    <ol aria-label="これまでの回答" className="mt-2 space-y-3">
      {answers.map((value,index) => <li key={index} className="rounded bg-muted p-3 text-sm"><p className="font-medium">{index + 1}. {GENERATOR_QUESTIONS[index].title}</p><p className="mt-1 whitespace-pre-wrap break-words">{value}</p></li>)}
    </ol></details>
    {!draft && question && <form onSubmit={answer} className="space-y-3">
      <p className="text-xs text-muted-foreground">質問 {answers.length + 1} / {GENERATOR_QUESTIONS.length}</p>
      <label className="block font-medium" htmlFor="generator-answer">{question.title}</label><p id="generator-hint" className="text-sm text-muted-foreground">{question.hint}</p>
      <fieldset className="space-y-2"><legend className="text-sm">候補（複数選択可・選んだ内容をすべて反映）</legend><div className="flex flex-wrap gap-2">{question.examples.map(example=><label key={example} className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm ${selectedOptions.includes(example)?"border-primary bg-muted":""}`}><input type="checkbox" checked={selectedOptions.includes(example)} onChange={()=>setSelectedOptions(previous=>toggleGeneratorOption(previous,example))}/>{example}</label>)}</div></fieldset>
      <label htmlFor="generator-answer" className="block text-sm">補足・自由入力（候補だけでも進められます）</label>
      <textarea id="generator-answer" ref={answerInput} aria-describedby="generator-hint" value={input} maxLength={1200} onChange={e=>setInput(e.target.value)} className="min-h-28 w-full rounded border bg-background p-3 text-sm" />
      {skillBytes(combinedAnswer)>1200&&<p role="alert" className="text-sm text-red-600">候補と補足の合計を1,200バイト以内にしてください。</p>}
      <div className="flex gap-2"><button type="submit" disabled={!combinedAnswer||skillBytes(combinedAnswer)>1200} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{answers.length===4?"Skill案を生成":"次へ"}</button>{answers.length>0&&<button type="button" onClick={back} className="rounded border px-3 py-2">一つ戻る</button>}</div>
    </form>}
    {busy&&<p role="status" className="text-sm">Skill案を生成しています…</p>}
    {!draft&&!question&&!busy&&<div className="flex gap-2"><button type="button" className="rounded bg-primary px-4 py-2 text-primary-foreground" onClick={()=>void generate(answers)}>もう一度生成</button><button type="button" onClick={back} className="rounded border px-3 py-2">回答を見直す</button></div>}
    {draft&&<div className="space-y-3">
      <h3 className="font-semibold">生成したSkill案：{draft.title}</h3><p className="text-sm text-muted-foreground">{draft.description}</p>
      <pre aria-label="生成したプロンプト案" className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap break-words rounded border bg-background p-3 font-mono text-sm">{draft.content}</pre>
      <form className="space-y-2" onSubmit={event=>{event.preventDefault();void generate(answers,revision.trim());}}>
        <label className="block text-sm font-medium" htmlFor="generator-revision">修正したい点</label>
        <textarea id="generator-revision" disabled={busy||saving} value={revision} maxLength={1200} onChange={e=>setRevision(e.target.value)} placeholder="例：結果を表形式にして、未確認事項も最後にまとめて" className="min-h-20 w-full rounded border bg-background p-2 text-sm" />
        <button type="submit" disabled={busy||saving||!revision.trim()||skillBytes(revision)>1200} className="rounded border px-3 py-2 text-sm disabled:opacity-50">AIに修正を依頼</button>
      </form>
    </div>}
  </section>;
}
