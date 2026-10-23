"use client";
import {useRef,useState} from "react";
import type {CanvasDocument} from "./canvas-rules";
export type SharedCanvasEdits=Pick<CanvasDocument,"title"|"content"|"unit"|"period"|"chartType"|"tableIndex"|"valueColumn">;
export function SharedCanvasEditor({document,busy,onSave,onCancel}:{document:CanvasDocument;busy:boolean;onSave:(input:SharedCanvasEdits)=>Promise<boolean>;onCancel:()=>void}) {
  const [draft,setDraft]=useState<SharedCanvasEdits>({title:document.title,content:document.content,unit:document.unit,period:document.period,chartType:document.chartType,tableIndex:document.tableIndex,valueColumn:document.valueColumn});
  const saving=useRef(false);
  return <form className="space-y-3 rounded border p-4" aria-label="共有レポートを編集" onSubmit={e=>{e.preventDefault();if(saving.current||busy)return;saving.current=true;void onSave(draft).then(ok=>{if(ok)onCancel();}).finally(()=>{saving.current=false;});}}>
    <h2 className="font-semibold">共有レポートを編集</h2>
    <p className="text-sm">保存すると同じ共有URLへ反映します。元のチャットのCanvasとSalesforceのレコードは変更しません。</p>
    <label className="block">タイトル<input className="block w-full rounded border bg-background p-2" maxLength={120} disabled={busy} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
    <label className="block">本文<textarea className="block min-h-64 w-full rounded border bg-background p-2" maxLength={60000} disabled={busy} value={draft.content} onChange={e=>setDraft({...draft,content:e.target.value})}/></label>
    <div className="grid grid-cols-2 gap-3">
      <label>単位<input className="block w-full rounded border bg-background p-2" disabled={busy} maxLength={40} value={draft.unit} onChange={e=>setDraft({...draft,unit:e.target.value})}/></label>
      <label>対象期間<input className="block w-full rounded border bg-background p-2" disabled={busy} maxLength={120} value={draft.period} onChange={e=>setDraft({...draft,period:e.target.value})}/></label>
      <label>グラフ<select className="block rounded border bg-background p-2" disabled={busy} value={draft.chartType} onChange={e=>setDraft({...draft,chartType:e.target.value as "bar"|"line"})}><option value="bar">棒グラフ</option><option value="line">折れ線グラフ</option></select></label>
      <label>対象の表（1から）<input type="number" min={1} max={10} className="block w-full rounded border bg-background p-2" disabled={busy} value={draft.tableIndex+1} onChange={e=>setDraft({...draft,tableIndex:Number(e.target.value)-1})}/></label>
      <label>数値の列（1から、2列目以降）<input type="number" min={2} max={101} className="block w-full rounded border bg-background p-2" disabled={busy} value={draft.valueColumn+1} onChange={e=>setDraft({...draft,valueColumn:Number(e.target.value)-1})}/></label>
    </div>
    <div className="flex gap-4"><button type="submit" className="rounded bg-primary px-3 py-2 text-primary-foreground" disabled={busy||!draft.title.trim()}>{busy?"保存中…":"変更を保存"}</button><button type="button" className="underline" onClick={onCancel} disabled={busy}>取消</button></div>
  </form>;
}
