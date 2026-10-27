"use client";
import { useEffect, useRef, useState } from "react";
import { importSkill, skillBytes, SKILL_CONTENT_BYTES } from "./skill-rules";
import type { SharedSkill, SkillInput, UserSkill } from "./skill-rules";
import { SkillGenerator } from "./skill-generator";
import { notifySkillCatalogChanged } from "./skill-suggestions";

const blank: SkillInput = {title:"",description:"",content:"",enabled:true,shared:false};
const formOf = (item: UserSkill): SkillInput => ({title:item.title,description:item.description,content:item.content,enabled:item.enabled,shared:item.shared});
export function SkillsPage() {
  const [items,setItems]=useState<UserSkill[]>([]);
  const [shared,setShared]=useState<SharedSkill[]>([]);
  const [selected,setSelected]=useState<UserSkill|null>(null);
  const [form,setForm]=useState<SkillInput>(blank);
  const [search,setSearch]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [generating,setGenerating]=useState(false);
  const [editorOpen,setEditorOpen]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null);
  const changed = selected ? JSON.stringify(form)!==JSON.stringify(formOf(selected)) : !!(form.title||form.description||form.content);
  async function refresh() {
    const response=await fetch("/api/skills",{cache:"no-store"});
    const data=await response.json();
    if (!response.ok) throw new Error(data.error||"Skillsを取得できませんでした。");
    setItems(data.items);setShared(Array.isArray(data.shared)?data.shared:[]);
  }
  useEffect(()=>{void refresh().catch(cause=>setError(String(cause))).finally(()=>setLoading(false));},[]);
  function canLeave() { return !changed || window.confirm("保存していない変更があります。変更を破棄しますか？"); }
  function choose(item:UserSkill|null) {
    if (!canLeave()) return;
    setSelected(item); setForm(item?formOf(item):blank);
    setEditorOpen(true);
    setError("");setNotice("");
  }
  async function save(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setError("");setNotice("");
    try {
      const response=await fetch("/api/skills",{method:selected?"PUT":"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({...form,id:selected?.id,version:selected?.version})});
      const data=await response.json();
      if (!response.ok) throw new Error(data.error||"保存できませんでした。");
      notifySkillCatalogChanged();setSelected(data.item);setForm(formOf(data.item));
      await refresh();setEditorOpen(false);setNotice(`「${data.item.title}」を保存しました。`);
    } catch(cause) {setError(cause instanceof Error?cause.message:String(cause));} finally {setBusy(false);}
  }
  async function remove() {
    if (!selected||!window.confirm(`Skill「${selected.title}」を削除しますか？`)) return;
    setBusy(true);setError("");setNotice("");
    try {
      const response=await fetch("/api/skills",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:selected.id,version:selected.version})});
      const data=await response.json(); if (!response.ok) throw new Error(data.error||"削除できませんでした。");
      notifySkillCatalogChanged();setSelected(null);setForm(blank);setEditorOpen(false);await refresh();setNotice("Skillを削除しました。");
    } catch(cause) {setError(cause instanceof Error?cause.message:String(cause));} finally {setBusy(false);}
  }
  async function upload(file:File|undefined) {
    if (!file||!canLeave()) return;
    setError("");setNotice("");
    try {
      if (!/\.md$/i.test(file.name)||file.size>SKILL_CONTENT_BYTES+2000) throw new Error("14,000バイト以内のMarkdownファイルを選択してください。");
      const imported=importSkill(await file.text());
      setSelected(null);setForm({...blank,...imported});setEditorOpen(true);setNotice("ファイルを読み込みました。名前と本文を確認して保存してください。");
    } catch(cause) {setError(cause instanceof Error?cause.message:String(cause));}
  }
  function copyShared(item:SharedSkill) {
    if (!canLeave()) return;
    setSelected(null);setForm({title:item.title,description:item.description,content:item.content,enabled:true,shared:false});
    setEditorOpen(true);setError("");setNotice(`「${item.title}」をコピーしました。必要に応じて名前・本文を変えて保存してください。`);
  }
  const filtered=items.filter(item=>`${item.title} ${item.description}`.toLowerCase().includes(search.toLowerCase()));
  const filteredShared=shared.filter(item=>`${item.title} ${item.description} ${item.ownerName}`.toLowerCase().includes(search.toLowerCase()));
  const bytes=skillBytes(form.content);
  return <main className="mx-auto h-dvh min-h-0 w-full max-w-6xl overflow-y-auto p-4 md:p-6">
    <h1 className="text-2xl font-semibold">Skills</h1>
    <p className="mt-2 text-sm text-muted-foreground">仕事ごとの「やり方」をプロンプトとして保存する、あなた専用のスペースです。</p>
    <p className="mt-1 text-sm text-muted-foreground">チャットに依頼を書くと、本人のSkillと全社公開Skillの候補が出ます。↑↓で選んでTabで確定するか、「（Skill名）を使って〇〇して」と指定します。</p>
    <section aria-labelledby="skills-execution" className="mt-6 rounded border-2 border-slate-400 dark:border-slate-500 p-4 md:p-5">
      <h2 id="skills-execution" className="text-lg font-semibold">1 Skills実行</h2>
      <div className="mt-3 pl-4">
        <a href="/salesforce/daily-report" className="inline-block rounded border border-slate-400 dark:border-slate-500 px-4 py-2 text-sm underline underline-offset-4">営業活動を日報に登録</a>
        <p className="mt-2 text-sm text-muted-foreground">保存したSkillは、チャットで「Skill『保存名』を使って…」と指定して実行できます。</p>
      </div>
    </section>
    <section aria-labelledby="skills-create" className="mt-5 rounded border-2 border-slate-400 dark:border-slate-500 p-4 md:p-5">
      <h2 id="skills-create" className="text-lg font-semibold">2 Skillの作成</h2>
      <div className="mt-4 grid gap-5 pl-4 md:grid-cols-[17rem_1fr]">
      <div className="space-y-5">
        <section aria-labelledby="skills-new" className="space-y-3">
        <h3 id="skills-new" className="font-medium">1) 新しいSkillの作成</h3>
        <button type="button" disabled={busy||loading||generating} onClick={()=>choose(null)} className="w-full rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">＋ 新しいSkill</button>
        <button type="button" disabled={busy||loading||generating} onClick={()=>{if(canLeave()){setGenerating(true);setError("");setNotice("");}}} className="w-full rounded border border-slate-400 dark:border-slate-500 px-3 py-2 disabled:opacity-50">AIと作成</button>
        </section>
        <section aria-labelledby="skills-import" className="space-y-3">
        <h3 id="skills-import" className="font-medium">2) Skillのインポート</h3>
        <input ref={fileInput} type="file" accept=".md,text/markdown" className="sr-only" aria-label="skill.mdを読み込む" onChange={event=>{void upload(event.target.files?.[0]);event.target.value="";}} />
        <button type="button" disabled={busy||loading||generating} className="w-full rounded border border-slate-400 dark:border-slate-500 px-3 py-2 text-sm disabled:opacity-50" onClick={()=>fileInput.current?.click()}>Markdownファイル(.md)を読み込む</button>
        </section>
      </div>
      {generating ? <SkillGenerator skills={items} shared={shared} onClose={()=>setGenerating(false)} onSaved={item=>{
        notifySkillCatalogChanged();
        setGenerating(false);setEditorOpen(false);setSelected(item);setForm(formOf(item));setError("");setNotice(`「${item.title}」をSkillsに保存しました。`);
        void refresh().catch(()=>setItems(previous=>[item,...previous.filter(skill=>skill.id!==item.id)]));
      }} onApply={(draft,baseId,baseVersion)=>{
        // Improving an own Skill opens it for update; anything else becomes a new Skill.
        const original=baseId?items.find(item=>item.id===baseId):undefined;
        setSelected(original?{...original,version:baseVersion??original.version}:null);setForm(draft);setGenerating(false);setEditorOpen(true);setError("");setNotice("生成した案を取り込みました。内容を確認・編集して保存してください。");
      }} /> : editorOpen ? <form onSubmit={save} className="min-w-0 space-y-4 rounded border border-slate-400 dark:border-slate-500 p-4 md:p-5">
        <fieldset disabled={busy||loading} className="space-y-4 disabled:opacity-60">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{selected?"Skillを編集":"Skillを作成"}</h3><div className="flex gap-2">
            <button type="button" className="rounded border border-slate-400 dark:border-slate-500 px-3 py-1 text-sm" onClick={()=>{if(canLeave()){setEditorOpen(false);setSelected(null);setForm(blank);setError("");setNotice("");}}}>閉じる</button>
            {selected&&<a aria-disabled={busy} href={busy?undefined:`/api/skills?download=${encodeURIComponent(selected.id)}`} className={`rounded border border-slate-400 dark:border-slate-500 px-3 py-1 text-sm ${busy?"pointer-events-none opacity-50":""}`}>skill.mdをダウンロード</a>}
          </div></div>
          <label className="block text-sm font-medium">名前<input required maxLength={120} value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="例：取引先情報" className="mt-1 w-full rounded border border-slate-400 dark:border-slate-500 bg-background p-2" /></label>
          <label className="block text-sm font-medium">説明（任意）<input maxLength={300} value={form.description} onChange={e=>setForm({...form,description:e.target.value})} placeholder="どんな仕事で、どう使うプロンプトか" className="mt-1 w-full rounded border border-slate-400 dark:border-slate-500 bg-background p-2" /></label>
          <label className="block text-sm font-medium">プロンプト本文（Markdown）<textarea required maxLength={12000} value={form.content} onChange={e=>setForm({...form,content:e.target.value})} className="mt-1 min-h-[22rem] w-full rounded border border-slate-400 dark:border-slate-500 bg-background p-3 font-mono text-sm" placeholder={'# 目的\n\n# 入力する情報\n\n# 進め方\n\n# 出力形式'} /></label>
          <p className={`text-xs ${bytes>SKILL_CONTENT_BYTES?"text-red-600":"text-muted-foreground"}`}>{bytes.toLocaleString()} / {SKILL_CONTENT_BYTES.toLocaleString()} バイト · 呼び出したときだけ参照します</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})} />チャットからの呼び出しを有効にする</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.shared===true} onChange={e=>setForm({...form,shared:e.target.checked})} />全社に公開する（他の社員が閲覧・利用・コピーできます。編集はあなただけ）</label>
          <div className="flex gap-3"><button disabled={bytes>SKILL_CONTENT_BYTES} type="submit" className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy?"保存中…":"保存"}</button>{selected&&<button type="button" className="rounded border border-slate-400 dark:border-slate-500 px-4 py-2" onClick={()=>void remove()}>削除</button>}</div>
        </fieldset>
      </form> : null}
      </div>
      {error&&<p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      {notice&&<p role="status" className="mt-3 text-sm">{notice}</p>}
    </section>
    <section aria-labelledby="skills-library" className="mt-5 rounded border-2 border-slate-400 dark:border-slate-500 p-4 md:p-5">
      <h2 id="skills-library" className="text-lg font-semibold">3 Skillsライブラリー</h2>
      <div className="mt-4 space-y-3 pl-4">
        <p className="text-sm text-muted-foreground">Skillを選択すると、上の作成欄で内容を確認・編集できます。</p>
        <label className="block max-w-md text-sm">検索<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="名前・説明で検索" className="mt-1 w-full rounded border border-slate-400 dark:border-slate-500 bg-background p-2" /></label>
        {loading?<p role="status" className="text-sm">読み込み中…</p>:<p className="text-xs text-muted-foreground">{items.length}件保存済み · 公開中{items.filter(item=>item.shared).length}件</p>}
        {!loading&&!filtered.length&&<p className="text-sm text-muted-foreground">{items.length?"一致するSkillがありません。":"まだSkillはありません。新規作成またはインポートから追加できます。"}</p>}
        <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map(item=><button type="button" disabled={busy||generating} key={item.id} aria-pressed={selected?.id===item.id} onClick={()=>{choose(item);}} className={`flex h-full w-full flex-col items-start rounded border border-slate-400 dark:border-slate-500 p-3 text-left disabled:opacity-50 ${selected?.id===item.id?"!border-primary bg-muted":"hover:border-slate-600 dark:hover:border-slate-300"}`}>
            <span className="block break-words font-medium">{item.title}</span>
            {item.description&&<span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">{item.description}</span>}
            <span className="mt-1 block text-xs text-muted-foreground">v{item.version}{item.enabled?"":" · 無効"}{item.shared?" · 全社公開":""}</span>
          </button>)}
        </div>
        <h3 className="pt-3 font-medium">全社公開のSkill（他の社員）</h3>
        <p className="text-xs text-muted-foreground">他の社員が公開したSkillです。有効なSkillはチャットの候補から直接利用できます。自分用に編集したい場合はコピーしてください（元のSkillは変わりません）。</p>
        {!loading&&!filteredShared.length&&<p className="text-sm text-muted-foreground">{shared.length?"一致する公開Skillがありません。":"まだ公開されたSkillはありません。"}</p>}
        <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {filteredShared.map(item=><div key={item.ref} className="flex h-full flex-col items-start rounded border border-dashed border-slate-400 p-3 dark:border-slate-500">
            <span className="block break-words font-medium">{item.title}</span>
            {item.description&&<span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">{item.description}</span>}
            <span className="mt-1 block text-xs text-muted-foreground">作成：{item.ownerName}</span>
            <button type="button" disabled={busy||generating} onClick={()=>copyShared(item)} className="mt-auto rounded border border-slate-400 px-3 py-1 text-xs disabled:opacity-50 dark:border-slate-500">コピーして使う</button>
          </div>)}
        </div>
      </div>
    </section>
  </main>;
}
