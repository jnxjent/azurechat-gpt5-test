"use client";
import { useEffect, useRef, useState } from "react";
import { importSkill, skillBytes, SKILL_CONTENT_BYTES } from "./skill-rules";
import type { SkillInput, UserSkill } from "./skill-rules";
import { SkillGenerator } from "./skill-generator";

const blank: SkillInput = {title:"",description:"",content:"",enabled:true};
type Legacy = {id:string;title:string;content:string};
export function SkillsPage() {
  const [items,setItems]=useState<UserSkill[]>([]);
  const [selected,setSelected]=useState<UserSkill|null>(null);
  const [form,setForm]=useState<SkillInput>(blank);
  const [search,setSearch]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [legacy,setLegacy]=useState<Legacy[]|null>(null);
  const [generating,setGenerating]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null);
  const changed = selected ? JSON.stringify(form)!==JSON.stringify({title:selected.title,description:selected.description,content:selected.content,enabled:selected.enabled}) : !!(form.title||form.description||form.content);
  async function refresh() {
    const response=await fetch("/api/skills",{cache:"no-store"});
    const data=await response.json();
    if (!response.ok) throw new Error(data.error||"Skillsを取得できませんでした。");
    setItems(data.items);
  }
  useEffect(()=>{void refresh().catch(cause=>setError(String(cause))).finally(()=>setLoading(false));},[]);
  function canLeave() { return !changed || window.confirm("保存していない変更があります。変更を破棄しますか？"); }
  function choose(item:UserSkill|null) {
    if (!canLeave()) return;
    setSelected(item); setForm(item?{title:item.title,description:item.description,content:item.content,enabled:item.enabled}:blank);
    setError("");setNotice("");
  }
  async function save(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setError("");setNotice("");
    try {
      const response=await fetch("/api/skills",{method:selected?"PUT":"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({...form,id:selected?.id,version:selected?.version})});
      const data=await response.json();
      if (!response.ok) throw new Error(data.error||"保存できませんでした。");
      setSelected(data.item);setForm({title:data.item.title,description:data.item.description,content:data.item.content,enabled:data.item.enabled});
      await refresh();setNotice(`「${data.item.title}」を保存しました。`);
    } catch(cause) {setError(cause instanceof Error?cause.message:String(cause));} finally {setBusy(false);}
  }
  async function remove() {
    if (!selected||!window.confirm(`Skill「${selected.title}」を削除しますか？`)) return;
    setBusy(true);setError("");setNotice("");
    try {
      const response=await fetch("/api/skills",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:selected.id,version:selected.version})});
      const data=await response.json(); if (!response.ok) throw new Error(data.error||"削除できませんでした。");
      setSelected(null);setForm(blank);await refresh();setNotice("Skillを削除しました。");
    } catch(cause) {setError(cause instanceof Error?cause.message:String(cause));} finally {setBusy(false);}
  }
  async function upload(file:File|undefined) {
    if (!file||!canLeave()) return;
    setError("");setNotice("");
    try {
      if (!/\.md$/i.test(file.name)||file.size>SKILL_CONTENT_BYTES+2000) throw new Error("14,000バイト以内のMarkdownファイルを選択してください。");
      const imported=importSkill(await file.text());
      setSelected(null);setForm({...blank,...imported});setNotice("ファイルを読み込みました。名前と本文を確認して保存してください。");
    } catch(cause) {setError(cause instanceof Error?cause.message:String(cause));}
  }
  async function readLegacy() {
    setBusy(true);setError("");
    try {
      const response=await fetch("/api/memories",{cache:"no-store"}); const data=await response.json();
      if (!response.ok) throw new Error(data.error||"以前のメモを取得できませんでした。"); setLegacy(data.items);
    } catch(cause) {setError(cause instanceof Error?cause.message:String(cause));} finally {setBusy(false);}
  }
  const filtered=items.filter(item=>`${item.title} ${item.description}`.toLowerCase().includes(search.toLowerCase()));
  const bytes=skillBytes(form.content);
  return <main className="mx-auto h-dvh min-h-0 w-full max-w-6xl overflow-y-auto p-4 md:p-6">
    <h1 className="text-2xl font-semibold">Skills</h1>
    <a href="/salesforce/daily-report" className="inline-block underline">営業活動を日報に登録</a>
    <p className="mt-2 text-sm text-muted-foreground">仕事ごとの「やり方」をプロンプトとして保存する、あなた専用のスペースです。</p>
    <p className="mt-1 text-sm text-muted-foreground">例：取引先情報、見積依頼先提案、予実分析。使うときはチャットで「Skill『保存名』を使って…」と指定します。</p>
    <div className="mt-5 grid gap-5 md:grid-cols-[17rem_1fr]">
      <aside aria-label="保存したSkills" className="space-y-3">
        <button type="button" disabled={busy||loading||generating} onClick={()=>choose(null)} className="w-full rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">＋ 新しいSkill</button>
        <button type="button" disabled={busy||loading||generating} onClick={()=>{if(canLeave()){setGenerating(true);setError("");setNotice("");}}} className="w-full rounded border px-3 py-2 disabled:opacity-50">AIと作成</button>
        <label className="block text-sm">検索<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="名前・説明で検索" className="mt-1 w-full rounded border bg-background p-2" /></label>
        {loading?<p role="status" className="text-sm">読み込み中…</p>:<p className="text-xs text-muted-foreground">{items.length}件保存済み · 本人専用</p>}
        {!loading&&!filtered.length&&<p className="text-sm text-muted-foreground">{items.length?"一致するSkillがありません。":"まだSkillはありません。新規作成またはファイル読込から追加できます。"}</p>}
        <div className="max-h-[55vh] space-y-2 overflow-y-auto">
          {filtered.map(item=><button type="button" disabled={busy||generating} key={item.id} aria-pressed={selected?.id===item.id} onClick={()=>choose(item)} className={`w-full rounded border p-3 text-left ${selected?.id===item.id?"border-primary bg-muted":""}`}>
            <span className="block break-words font-medium">{item.title}</span>
            {item.description&&<span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">{item.description}</span>}
            <span className="mt-1 block text-xs text-muted-foreground">v{item.version}{item.enabled?"":" · 無効"}</span>
          </button>)}
        </div>
        <button type="button" disabled={busy||generating} onClick={()=>void readLegacy()} className="w-full rounded border px-3 py-2 text-sm">以前のメモから取り込む</button>
        {legacy&&<div className="rounded border p-2 text-sm"><p className="mb-2 text-xs text-muted-foreground">選択後に保存するとSkillになります。元のメモは残ります。</p>
          {!legacy.length&&<p>以前のメモはありません。</p>}
          {legacy.map(item=><button type="button" disabled={busy||generating} className="block w-full rounded p-2 text-left hover:bg-muted" key={item.id} onClick={()=>{
            if (!canLeave())return;setSelected(null);setForm({...blank,title:item.title,content:item.content});setNotice("取り込む本文を確認して保存してください。");setError("");
          }}>{item.title}</button>)}
        </div>}
      </aside>
      {generating ? <SkillGenerator onClose={()=>setGenerating(false)} onSaved={item=>{
        setItems(previous=>[item,...previous.filter(skill=>skill.id!==item.id)]);
        setSelected(item);setForm({title:item.title,description:item.description,content:item.content,enabled:item.enabled});
        setGenerating(false);setError("");setNotice(`「${item.title}」をSkillsに保存しました。`);
      }} onApply={draft=>{
        setSelected(null);setForm(draft);setGenerating(false);setError("");setNotice("生成した案を取り込みました。内容を確認・編集して保存してください。");
      }} /> : <form onSubmit={save} className="min-w-0 space-y-4 rounded border p-4 md:p-5">
        <fieldset disabled={busy||loading} className="space-y-4 disabled:opacity-60">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">{selected?"Skillを編集":"Skillを作成"}</h2><div className="flex gap-2">
            <input ref={fileInput} type="file" accept=".md,text/markdown" className="sr-only" aria-label="skill.mdを読み込む" onChange={event=>{void upload(event.target.files?.[0]);event.target.value="";}} />
            <button type="button" className="rounded border px-3 py-1 text-sm" onClick={()=>fileInput.current?.click()}>.mdを読み込む</button>
            {selected&&<a aria-disabled={busy} href={busy?undefined:`/api/skills?download=${encodeURIComponent(selected.id)}`} className={`rounded border px-3 py-1 text-sm ${busy?"pointer-events-none opacity-50":""}`}>skill.mdをダウンロード</a>}
          </div></div>
          <label className="block text-sm font-medium">名前<input required maxLength={120} value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="例：取引先情報" className="mt-1 w-full rounded border bg-background p-2" /></label>
          <label className="block text-sm font-medium">説明（任意）<input maxLength={300} value={form.description} onChange={e=>setForm({...form,description:e.target.value})} placeholder="どんな仕事で、どう使うプロンプトか" className="mt-1 w-full rounded border bg-background p-2" /></label>
          <label className="block text-sm font-medium">プロンプト本文（Markdown）<textarea required maxLength={12000} value={form.content} onChange={e=>setForm({...form,content:e.target.value})} className="mt-1 min-h-[22rem] w-full rounded border bg-background p-3 font-mono text-sm" placeholder={'# 目的\n\n# 入力する情報\n\n# 進め方\n\n# 出力形式'} /></label>
          <p className={`text-xs ${bytes>SKILL_CONTENT_BYTES?"text-red-600":"text-muted-foreground"}`}>{bytes.toLocaleString()} / {SKILL_CONTENT_BYTES.toLocaleString()} バイト · 呼び出したときだけ参照します</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})} />チャットからの呼び出しを有効にする</label>
          <div className="flex gap-3"><button disabled={bytes>SKILL_CONTENT_BYTES} type="submit" className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy?"保存中…":"保存"}</button>{selected&&<button type="button" className="rounded border px-4 py-2" onClick={()=>void remove()}>削除</button>}</div>
        </fieldset>
        {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
        {notice&&<p role="status" className="text-sm">{notice}</p>}
      </form>}
    </div>
  </main>;
}
