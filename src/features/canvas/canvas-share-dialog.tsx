"use client";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/features/ui/dialog";
type Person={email:string;name:string};
export function CanvasPeoplePicker({selected,onChange,disabled=false}:{selected:string[];onChange:(value:string[])=>void;disabled?:boolean}) {
  const [query,setQuery]=useState(""),[items,setItems]=useState<Person[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(""),[more,setMore]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError("");setItems([]);
    const timer=setTimeout(()=>{void(async()=>{
      try {
        const response=await fetch(`/api/canvas/shared/people?q=${encodeURIComponent(query)}`,{cache:"no-store",signal:controller.signal});
        const data=await response.json();if(!response.ok)throw Error(data.error||"候補を検索できませんでした。");
        if(!controller.signal.aborted){setItems(data.items);setMore(data.hasMore);}
      }catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:"候補を検索できませんでした。");}
      finally{if(!controller.signal.aborted)setLoading(false);}
    })();},250);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query]);
  return <div className="space-y-3">
    <label className="block text-sm">共有先を検索<input className="mt-1 block w-full rounded border bg-background p-2" placeholder="名前・メールアドレス" maxLength={120} value={query} disabled={disabled} onChange={e=>setQuery(e.target.value)}/></label>
    <div className="max-h-48 overflow-y-auto rounded border p-2" aria-label="共有先の候補" aria-busy={loading}>
      {loading?<p role="status">検索中…</p>:error?<p role="alert">{error}</p>:items.length?<ul>{items.map(person=><li key={person.email}><label className="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-muted"><input type="checkbox" disabled={disabled||(!selected.includes(person.email)&&selected.length>=50)} checked={selected.includes(person.email)} onChange={e=>onChange(e.target.checked?[...selected,person.email]:selected.filter(email=>email!==person.email))}/><span><span className="block">{person.name}</span>{person.name!==person.email&&<span className="block text-xs text-muted-foreground">{person.email}</span>}</span></label></li>)}</ul>:<p>候補が見つかりません。</p>}
    </div>
    {more&&<p className="text-xs">候補が多いため、名前・メールアドレスで絞り込んでください。</p>}
    <div aria-label="選択した共有先" className="space-y-1"><p className="text-sm">選択済み：{selected.length}人</p>{selected.map(email=><div key={email} className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-sm"><span className="break-all">{email}</span><button type="button" className="shrink-0 underline" disabled={disabled} aria-label={`${email}を共有先から外す`} onClick={()=>onChange(selected.filter(value=>value!==email))}>外す</button></div>)}</div>
  </div>;
}
type Sharing={id:string|null;revision:number|null;readers:string[];enabled:boolean};
export function CanvasShareDialog({threadId,version,dirty,saveCanvas,onClose}:{threadId:string;version:number;dirty:boolean;saveCanvas:()=>Promise<number>;onClose:()=>void}) {
  const [sharing,setSharing]=useState<Sharing|null>(null),[selected,setSelected]=useState<string[]>([]),[enabled,setEnabled]=useState(true),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  useEffect(()=>{
    const controller=new AbortController();
    void(async()=>{try {
      const response=await fetch(`/api/canvas/shared/from-thread?threadId=${encodeURIComponent(threadId)}`,{cache:"no-store",signal:controller.signal});
      const data=await response.json();if(!response.ok)throw Error(data.error||"共有設定を確認できませんでした。");
      if(!controller.signal.aborted){setSharing(data);setSelected(data.readers);setEnabled(data.id?data.enabled:true);}
    }catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:"共有設定を確認できませんでした。");}finally{if(!controller.signal.aborted)setLoading(false);}})();
    return()=>controller.abort();
  },[threadId]);
  async function save() {
    if(!sharing||busy)return;setBusy(true);setError("");setNotice("");
    try {
      const savedVersion=enabled&&dirty?await saveCanvas():version;
      const response=await fetch("/api/canvas/shared/from-thread",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({threadId,version:savedVersion,revision:sharing.revision,readers:selected,enabled}),cache:"no-store"});
      const data=await response.json();if(!response.ok)throw Error(data.error||"共有を保存できませんでした。");
      setSharing(data);setSelected(data.readers);setEnabled(data.enabled);setNotice(data.enabled?"共有しました。同じURLで閲覧できます。":"共有を解除しました。");
    }catch(error){setError(error instanceof Error?error.message:"共有を保存できませんでした。");}finally{setBusy(false);}
  }
  const url=sharing?.id?`${window.location.origin}/canvas/shared/${sharing.id}`:"";
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="z-[80] max-h-[90vh] overflow-y-auto" onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>{if(busy)e.preventDefault();}}>
    <DialogHeader><DialogTitle>Canvasを共有</DialogTitle><DialogDescription>共有先を検索して選択してください。相手のSalesforce参照権限も確認されます。</DialogDescription></DialogHeader>
    {loading?<p role="status">共有設定を確認中…</p>:sharing&&<>
      <CanvasPeoplePicker selected={selected} onChange={setSelected} disabled={busy}/>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)}/>選択した相手への共有を有効にする</label>
      {dirty&&enabled&&<p className="text-sm">「共有を保存」で、現在のCanvasも保存して共有します。修正依頼が入力されている場合は、その修正も反映します。</p>}
      <button type="button" className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy||(enabled&&!selected.length)} onClick={()=>void save()}>{busy?"保存中…":enabled?"共有を保存":"共有を解除"}</button>
      {url&&sharing.enabled&&<div className="space-y-2"><label className="block text-sm">共有URL<input readOnly value={url} className="block w-full rounded border bg-background p-2" onFocus={e=>e.target.select()}/></label><button type="button" className="rounded border px-3 py-1" onClick={()=>{void navigator.clipboard.writeText(url).then(()=>setNotice("共有URLをコピーしました。Teamsなどに貼り付けてください。"),()=>setError("URL欄からコピーしてください。"));}}>共有URLをコピー</button></div>}
      <p className="text-xs text-muted-foreground">本文とグラフを共有します。Canvasを編集した後も「共有を保存」で、保存と同じURLへの反映をまとめて行えます。</p>
    </>}
    {error&&<p role="alert" className="text-sm text-red-500">{error}</p>}{notice&&<p role="status" className="text-sm">{notice}</p>}
  </DialogContent></Dialog>;
}
