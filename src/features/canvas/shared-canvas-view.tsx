"use client";
import {canvasFetch} from "./canvas-fetch";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CanvasChart } from "./canvas-panel";
import { canvasTables, type CanvasDocument } from "./canvas-rules";
import { CanvasPeoplePicker,canvasNotificationNotice } from "./canvas-share-dialog";
import { canvasReportLayout } from "./canvas-report-layout";
import { CanvasComments,type SharedComment,type CommentChange } from "./canvas-comments";
import {SharedCanvasEditor,type SharedCanvasEdits} from "./shared-canvas-editor";
type Report = { revision: number; updatedAt: string; owner: boolean; readers?: string[];permissions?:Record<string,"view"|"comment"|"edit">; enabled?: boolean; savedCanvas?:boolean; restricted: boolean; document?: CanvasDocument; query?: string;comments?:SharedComment[];canComment?:boolean;canEdit?:boolean };
export function SharedCanvasView({ id,embedded=false }: { id: string;embedded?:boolean }) {
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState("");
  const [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [readers, setReaders] = useState<string[] | null>(null), [enabled, setEnabled] = useState<boolean | null>(null);
  const [permissions,setPermissions]=useState<Record<string,"view"|"comment"|"edit">|null>(null);
  const [editing,setEditing]=useState(false),[sharingMessage,setSharingMessage]=useState("");
  const [notifyTeams,setNotifyTeams]=useState(true);
  const generation = useRef(0), active = useRef<AbortController | null>(null);
  const endpoint = `/api/canvas/shared/${encodeURIComponent(id)}`;
  const sharingSection=useRef<HTMLDetailsElement>(null);
  function openSharing(activate=false){if(activate)setEnabled(true);if(sharingSection.current){sharingSection.current.open=true;sharingSection.current.scrollIntoView({block:"start"});}}
  function selectReaders(next:string[]){setReaders(next);setEnabled(next.length>0);}
  function showComments(send=false){const section=document.getElementById("comments");section?.scrollIntoView({block:"start"});const input=section?.querySelector("textarea");if(send&&input?.value.trim())section?.querySelector("form")?.requestSubmit();else input?.focus();}
  const load = useCallback(async (force = false) => {
    if (document.hidden || (active.current && !force)) return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const current = ++generation.current;
    try {
      const response = await canvasFetch(endpoint, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (current !== generation.current) return;
      if (!response.ok) throw Error(data.error || "Canvasを読み込めませんでした。");
      setReport(data); setError("");
    } catch (e) { if (current === generation.current && !controller.signal.aborted) { setReport(null); setError(e instanceof Error ? e.message : "Canvasを読み込めませんでした。"); } }
    finally { if (active.current === controller) active.current = null; }
  }, [endpoint]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 30000);
    const visibility = () => {
      if (document.hidden) { generation.current++; active.current?.abort(); active.current = null; setReport(null); }
      else void load(true);
    };
    const focus = () => { void load(); };
    const restore = () => { setReport(null); void load(true); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("focus", focus); window.addEventListener("pageshow", restore);
    return () => { generation.current++; active.current?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("focus", focus); window.removeEventListener("pageshow", restore); };
  }, [load]);
  async function change(action: "access" | "refresh") {
    if (!report) return; setBusy(true); setNotice(""); setOperationError("");
    generation.current++; active.current?.abort(); active.current = null;
    try {
      const selected=readers??report.readers??[];
      const response = await canvasFetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: report.revision, action, ...(action === "access" ? { readers:selected,permissions:Object.fromEntries(selected.map(email=>[email,(permissions??report.permissions)?.[email]??"view"])), enabled: enabled ?? report.enabled ?? false,message:(enabled??report.enabled)&&notifyTeams?sharingMessage:undefined,notifyTeams } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "更新できませんでした。");
      setReaders(null); setEnabled(null);setPermissions(null);setSharingMessage("");
      setNotice(action==="access"?(data.enabled?"共有設定を更新しました。"+(notifyTeams?(canvasNotificationNotice(data.notifications)||"Teams通知の結果を確認できませんでした。"):"Teams通知はオフのため送っていません。"):"共有を無効にしました。Teams通知は送っていません。") : "最新データを取得しました。同じURLで表示できます。");
    } catch (e) { setOperationError(e instanceof Error ? e.message : "更新できませんでした。"); }
    finally { setBusy(false); void load(true); }
  }
  async function comment(input:CommentChange):Promise<boolean> {
    if(!report||busy)return false;
    setBusy(true);setOperationError("");setNotice("");generation.current++;active.current?.abort();active.current=null;
    try {
      const post=(revision:number)=>fetch(`${endpoint}/comments`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...input,revision}),cache:"no-store"});
      let response=await post(report.revision);
      if(response.status===409&&input.action==="create") {
        const refreshed=await canvasFetch(endpoint,{cache:"no-store"}),latest=await refreshed.json();
        if(refreshed.ok&&!latest.restricted&&latest.canComment&&latest.document?.version===report.document?.version) {
          setReport(latest);response=await post(latest.revision);
        }else if(latest.restricted||!refreshed.ok&&[401,403,404].includes(refreshed.status)) {
          setReport(refreshed.ok?latest:null);throw Error(latest.error||"現在の参照権限を確認できません。");
        }
      }
      const data=await response.json();if(!response.ok)throw Error(data.error||"コメントを保存できませんでした。");
      // Use the committed result immediately; a subsequent refresh failure must
      // not clear a draft as if nothing was saved, or hide a successful post.
      setReport(previous=>{
        if(!previous)return previous;
        const comments=previous.comments??[];
        return {...previous,revision:data.revision,updatedAt:data.updatedAt,comments:comments.some(c=>c.id===data.comment.id)?comments.map(c=>c.id===data.comment.id?data.comment:c):[...comments,data.comment]};
      });
      setNotice(input.action==="delete"?"コメントを削除しました。":"コメントを投稿しました。");return true;
    }catch(error){setOperationError(error instanceof Error?error.message:"コメントを保存できませんでした。");return false;}
    finally{setBusy(false);}
  }
  async function saveEdit(document:SharedCanvasEdits):Promise<boolean> {
    if(!report||busy)return false;
    setBusy(true);setOperationError("");generation.current++;active.current?.abort();active.current=null;
    try {
      const response=await canvasFetch(endpoint,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:report.revision,action:"edit",document}),cache:"no-store"});
      const data=await response.json();if(!response.ok)throw Error(data.error||"変更を保存できませんでした。");
      setNotice("変更を保存しました。同じURLへ反映しました。");await load(true);return true;
    }catch(error){setOperationError(error instanceof Error?error.message:"変更を保存できませんでした。");return false;}
    finally{setBusy(false);}
  }
  const doc = report?.document, table = doc ? canvasTables(doc.content)[doc.tableIndex] : undefined;
  useEffect(()=>{
    if(doc&&window.location.hash==="#comments")document.getElementById("comments")?.scrollIntoView({block:"start"});
  },[Boolean(doc)]);
  const layout=doc?canvasReportLayout(doc):undefined;
  return <main className="mx-auto max-w-6xl p-6 space-y-5">
    <h1 className="text-2xl font-semibold">{layout?.title ?? "共有Canvas"}</h1>
    <p>指定された共有先だけが閲覧できます。表示時にSalesforceの現在の参照権限を確認します。</p>
    {embedded&&<nav aria-label="Canvas操作" className="sticky top-0 z-10 flex flex-wrap gap-2 border bg-background p-3 [&>button]:rounded [&>button]:border [&>button]:px-3 [&>button]:py-2 [&>button:disabled]:opacity-50">
      <button disabled={!report||busy} onClick={()=>{if(report?.owner)openSharing();else document.querySelector("article")?.scrollIntoView();}}>レポート・共有設定を開く</button>
      <button disabled={busy} onClick={()=>void load(true)}>状態を再確認</button>
      <button disabled={!doc||report?.restricted} onClick={()=>showComments()}>コメントを読む</button>
      <button disabled={!report?.canEdit||busy||report?.restricted} onClick={()=>setEditing(true)}>レポートを編集</button>
      <button disabled={!report?.owner||busy||report?.restricted} onClick={()=>openSharing(true)}>共有</button>
      <button disabled={!report?.canComment||busy||report?.restricted} onClick={()=>showComments(true)}>コメントを送信</button>
    </nav>}
    <button type="button" className="underline" onClick={() => { void load(true); }}>表示を再確認</button>
    {report?.document&&!report.restricted&&<a className="ml-4 underline" href="#comments">コメント（{(report.comments??[]).filter(c=>!c.deleted).length}件）へ移動</a>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status" className="whitespace-pre-line">{notice}</p>}
    {operationError && <p role="alert">{operationError}</p>}
    {!report && !error && <p role="status">閲覧権限を確認しています…</p>}
    {report && <p>最終更新：{new Date(report.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}（日本時間）／版：{report.revision}</p>}
    {report?.restricted && <p role="alert">現在のSalesforce権限を確認できないため、本文は表示していません。共有解除は下の設定から行えます。</p>}
    {report?.owner && <details ref={sharingSection} className="rounded border p-4"><summary className="cursor-pointer font-semibold">共有と更新</summary><section className="mt-3 space-y-3">
      <CanvasPeoplePicker selected={readers??report.readers??[]} onChange={selectReaders} permissions={permissions??report.permissions??{}} onPermissionsChange={setPermissions} disabled={busy}/>
      <label className="block text-sm">共有メッセージ（任意）<textarea className="mt-1 block w-full rounded border bg-background p-2" disabled={busy||!notifyTeams} maxLength={4000} value={sharingMessage} onChange={e=>setSharingMessage(e.target.value)}/><span className="text-xs">Teams通知でリンクと一緒に送信します。コメント欄には投稿しません。通知をオフにすると送信しません。</span></label>
      <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={notifyTeams} onChange={e=>setNotifyTeams(e.target.checked)}/><span>選択した相手に共有を通知する<small className="block">{embedded?"保存すると、相手とこのBOTのTeamsチャットへリンクを送ります。相手がこのBOTへ一度メッセージを送っている必要があります。":"あなたから相手へのTeams個人チャットに、共有リンクとメッセージを送ります。相手のBOT利用は不要です。権限がない場合は共有URLをコピーして送ってください。"}送信結果は保存後に下へ表示します。</small></span></label>
      <div className="flex flex-wrap gap-4">
        <button disabled={busy||Boolean(enabled??report.enabled)&&!(readers??report.readers??[]).length} type="button" className="rounded bg-primary px-3 py-2 text-primary-foreground" onClick={() => { void change("access"); }}>{busy?"処理中…":"共有設定を保存"}</button>
        <button disabled={busy} type="button" className="rounded border px-3 py-2" onClick={() => { void change("refresh"); }}>{report.savedCanvas?"保存済みCanvasを反映":"SFから内容を更新"}</button>
        <button type="button" className="rounded border px-3 py-2" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/canvas/shared/${encodeURIComponent(id)}`).then(() => setNotice("共有URLをコピーしました。Teamsに貼り付けられます。")).catch(() => setError("共有URLをコピーできませんでした。")); }}>共有URLをコピー</button>
      </div>
      {notice&&<p className="whitespace-pre-line rounded border bg-muted p-3">{notice}</p>}{operationError&&<p className="rounded border p-3 text-red-500">{operationError}</p>}
      <p className="text-sm">共有を解除するには共有先を外して保存してください。閲覧者の次回アクセス・再確認時に表示を停止します。{report.savedCanvas?"内容の更新では、元のチャットで保存したCanvasを同じURLへ反映します。":"更新は同じ依頼で再検索します。"}</p>
      {report.query && <p className="text-sm">取得依頼：{report.query}</p>}
    </section></details>}
    {!embedded&&doc&&report&&!report.restricted&&"canEdit" in report&&report.canEdit&&!editing&&<button className="rounded border px-3 py-2" type="button" disabled={busy} onClick={()=>setEditing(true)}>レポートを編集</button>}
    {doc&&editing&&report&&!report.restricted&&"canEdit" in report&&report.canEdit&&<SharedCanvasEditor document={doc} busy={busy} onSave={saveEdit} onCancel={()=>setEditing(false)}/>}
    {doc && <article className="prose max-w-none dark:prose-invert">
      <p>出典：{doc.source}{doc.period ? ` ／ 対象期間：${doc.period}` : ""}</p>
      {table && doc.unit && doc.period && <CanvasChart table={table} column={doc.valueColumn} columns={doc.valueColumns} type={doc.chartType} unit={doc.unit} />}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{layout?.body??doc.content}</ReactMarkdown>
    </article>}
    {doc&&report&&!report.restricted&&<CanvasComments comments={report.comments??[]} canComment={report.canComment??false} busy={busy} onChange={comment}/>}
  </main>;
}
