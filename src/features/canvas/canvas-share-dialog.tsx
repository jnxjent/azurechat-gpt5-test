"use client";
import {canvasFetch} from "./canvas-fetch";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/features/ui/dialog";
type Person={email:string;name:string;department?:string};
export function canvasNotificationNotice(value?:{channel?:string;sent:number;unavailable:number;failed:number;error?:string;recipients?:Array<{name:string;status:string;reason?:string}>}) {
  if(value?.channel==="personal")return ` Teams通知（あなたからの個人チャット）：送信${value.sent}件・権限なし等${value.unavailable}件・失敗${value.failed}件。${value.error??""}`+(value.recipients??[]).map(person=>`\n${person.name}：${person.status==="sent"?"送信済み":person.status==="permission_required"?"権限なし（再ログインが必要）":"失敗"}${person.reason?` — ${person.reason}`:""}`).join("");
  return value?` Teams通知：送信${value.sent}件・BOT未登録等${value.unavailable}件・失敗${value.failed}件。${value.error??""}`:"";
}
export function CanvasPeoplePicker({selected,onChange,disabled=false,permissions={},onPermissionsChange}:{selected:string[];onChange:(value:string[])=>void;disabled?:boolean;permissions?:Record<string,"view"|"comment"|"edit">;onPermissionsChange?:(value:Record<string,"view"|"comment"|"edit">)=>void}) {
  const [known,setKnown]=useState<Record<string,Person>>({});
  const [query,setQuery]=useState(""),[items,setItems]=useState<Person[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(""),[more,setMore]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError("");setItems([]);
    const timer=setTimeout(()=>{void(async()=>{
      try {
        const response=await canvasFetch(`/api/canvas/shared/people?q=${encodeURIComponent(query)}`,{cache:"no-store",signal:controller.signal});
        const data=await response.json();if(!response.ok)throw Error(data.error||"候補を検索できませんでした。");
        if(!controller.signal.aborted){setItems(data.items);setMore(data.hasMore);setKnown(previous=>({...previous,...Object.fromEntries(data.items.map((person:Person)=>[person.email,person]))}));}
      }catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:"候補を検索できませんでした。");}
      finally{if(!controller.signal.aborted)setLoading(false);}
    })();},250);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query]);
  return <div className="space-y-3">
    <label className="block text-sm">共有先を検索<input className="mt-1 block w-full rounded border bg-background p-2" placeholder="氏名・部署名・メールアドレス" maxLength={120} value={query} disabled={disabled} onChange={e=>setQuery(e.target.value)}/></label>
    <div className="max-h-48 overflow-y-auto rounded border p-2" aria-label="共有先の候補" aria-busy={loading}>
      {loading?<p role="status">検索中…</p>:error?<p role="alert">{error}</p>:items.length?<ul>{items.map(person=><li key={person.email}><label className="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-muted"><input type="checkbox" disabled={disabled||(!selected.includes(person.email)&&selected.length>=50)} checked={selected.includes(person.email)} onChange={e=>onChange(e.target.checked?[...selected,person.email]:selected.filter(email=>email!==person.email))}/><span><span className="block">{person.name}</span><span className="block text-xs text-muted-foreground">{person.department||"部署未登録"}</span>{person.name!==person.email&&<span className="block text-xs text-muted-foreground">{person.email}</span>}</span></label></li>)}</ul>:<p>候補が見つかりません。</p>}
    </div>
    {more&&<p className="text-xs">候補が多いため、名前・メールアドレスで絞り込んでください。</p>}
    <div aria-label="選択した共有先" className="space-y-1"><p className="text-sm">選択済み：{selected.length}人</p>{selected.map(email=><div key={email} className="flex flex-wrap items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-sm"><span className="break-all">{known[email]?.name??email}{known[email]&&<small className="block">{known[email].department||"部署未登録"} ／ {email}</small>}</span>{onPermissionsChange&&<select aria-label={`${email}の共有権限`} className="rounded border bg-background p-1" disabled={disabled} value={permissions[email]??"view"} onChange={e=>onPermissionsChange({...permissions,[email]:e.target.value as "view"|"comment"|"edit"})}><option value="view">閲覧可</option><option value="comment">コメント可</option><option value="edit">編集可</option></select>}<button type="button" className="shrink-0 underline" disabled={disabled} aria-label={`${email}を共有先から外す`} onClick={()=>onChange(selected.filter(value=>value!==email))}>外す</button></div>)}</div>
  </div>;
}
type Sharing={id:string|null;revision:number|null;readers:string[];permissions?:Record<string,"view"|"comment"|"edit">;enabled:boolean};
export function CanvasShareDialog({threadId,version,dirty,saveCanvas,onClose,reportTitle}:{threadId:string;version:number;dirty:boolean;saveCanvas:()=>Promise<number>;onClose:()=>void;reportTitle?:string}) {
  const [sharing,setSharing]=useState<Sharing|null>(null),[selected,setSelected]=useState<string[]>([]),[enabled,setEnabled]=useState(true),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [permissions,setPermissions]=useState<Record<string,"view"|"comment"|"edit">>({});
  const [message,setMessage]=useState("");
  const [notifyTeams,setNotifyTeams]=useState(true);
  useEffect(()=>{
    const controller=new AbortController();
    void(async()=>{try {
      const response=await canvasFetch(`/api/canvas/shared/from-thread?threadId=${encodeURIComponent(threadId)}`,{cache:"no-store",signal:controller.signal});
      const data=await response.json();if(!response.ok)throw Error(data.error||"共有設定を確認できませんでした。");
      if(!controller.signal.aborted){setSharing(data);setSelected(data.readers);setPermissions(data.permissions??{});setEnabled(data.id?data.enabled:true);}
    }catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:"共有設定を確認できませんでした。");}finally{if(!controller.signal.aborted)setLoading(false);}})();
    return()=>controller.abort();
  },[threadId]);
  async function save() {
    if(!sharing||busy)return;setBusy(true);setError("");setNotice("");
    try {
      const savedVersion=enabled&&dirty?await saveCanvas():version;
      const response=await canvasFetch("/api/canvas/shared/from-thread",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({threadId,version:savedVersion,revision:sharing.revision,readers:selected,permissions:Object.fromEntries(selected.map(email=>[email,permissions?.[email]??"view"])),enabled,message:enabled&&notifyTeams?message:undefined,notifyTeams:enabled&&notifyTeams}),cache:"no-store"});
      const data=await response.json();if(!response.ok)throw Error(data.error||"共有を保存できませんでした。");
      setSharing(data);setSelected(data.readers);setPermissions(data.permissions??{});setEnabled(data.enabled);setMessage("");setNotice((data.enabled?"共有しました。同じURLで閲覧できます。":"共有を解除しました。")+canvasNotificationNotice(data.notifications));
    }catch(error){setError(error instanceof Error?error.message:"共有を保存できませんでした。");}finally{setBusy(false);}
  }
  const url=sharing?.id?`${window.location.origin}/canvas/shared/${sharing.id}`:"";
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="z-[80] max-h-[90vh] overflow-y-auto" onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>{if(busy)e.preventDefault();}}>
    <DialogHeader><DialogTitle>Canvasを共有</DialogTitle><DialogDescription>共有先を検索して選択してください。相手のSalesforce参照権限も確認されます。</DialogDescription></DialogHeader>
    {reportTitle&&<p className="font-semibold">{reportTitle}</p>}
    {loading?<p role="status">共有設定を確認中…</p>:sharing&&<>
      <CanvasPeoplePicker selected={selected} onChange={next=>{setSelected(next);setEnabled(next.length>0);}} permissions={permissions} onPermissionsChange={setPermissions} disabled={busy}/>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={notifyTeams} disabled={busy} onChange={e=>setNotifyTeams(e.target.checked)}/><span>選択した相手に共有を通知する<small className="block">あなたから相手へのTeams個人チャットに、共有リンクとメッセージを送ります。相手のBOT利用は不要です。送信結果は相手ごとに表示します。権限がない場合は共有URLをコピーして送ってください。</small></span></label>
      {enabled&&<label className="block text-sm">共有メッセージ（任意）<textarea className="mt-1 block min-h-20 w-full rounded border bg-background p-2" value={message} onChange={e=>setMessage(e.target.value)} disabled={busy||!notifyTeams} maxLength={4000} placeholder="共有相手へのメッセージを入力"/><span className="text-xs">Teams通知でリンクと一緒に送信します。コメント欄には投稿しません。通知をオフにすると送信しません。</span></label>}
      <p className="text-sm">「共有を保存」で選択した相手に共有します。通知をオンにするとTeamsにも通知します。{dirty&&"現在のCanvasと入力済みの修正も保存して反映します。"}共有を解除するには共有先を外して保存してください。</p>
      <button type="button" className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy||(enabled&&!selected.length)} onClick={()=>void save()}>{busy?"保存中…":enabled?"共有を保存":"共有を解除"}</button>
      {url&&sharing.enabled&&<div className="space-y-2"><label className="block text-sm">共有URL<input readOnly value={url} className="block w-full rounded border bg-background p-2" onFocus={e=>e.target.select()}/></label><button type="button" className="rounded border px-3 py-1" onClick={()=>{void navigator.clipboard.writeText(url).then(()=>setNotice("共有URLをコピーしました。Teamsなどに貼り付けてください。"),()=>setError("URL欄からコピーしてください。"));}}>共有URLをコピー</button></div>}
      <p className="text-xs text-muted-foreground">本文とグラフを共有します。Canvasを編集した後も「共有を保存」で、保存と同じURLへの反映をまとめて行えます。</p>
    </>}
    {error&&<p role="alert" className="text-sm text-red-500">{error}</p>}{notice&&<p role="status" className="whitespace-pre-line text-sm">{notice}</p>}
  </DialogContent></Dialog>;
}
