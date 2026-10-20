"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { updateCanvas } from "./canvas-update";
import { Undo2, Redo2, MoreHorizontal, Printer, ImageDown, Copy } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/features/ui/dropdown-menu";
import { CanvasDocument, CanvasTable, canvasNumber, canvasTables, canvasMetadataSuggestions, canvasStep } from "./canvas-rules";
import { exportCanvasChart, printCanvas } from "./canvas-export";

export function CanvasSuggestionInput({value,suggestion,onChange,className,maxLength,placeholder,id}:{value:string;suggestion:string;onChange:(value:string)=>void;className:string;maxLength:number;placeholder:string;id:string}) {
  const available=!value&&!!suggestion;
  return <span className="block">
    <input id={id} className={`${className} placeholder:text-muted-foreground/60`} maxLength={maxLength} value={value} placeholder={available?suggestion:placeholder} aria-describedby={available?`${id}-hint`:undefined}
      onChange={e=>onChange(e.target.value)} onKeyDown={e=>{if(e.key==="Tab"&&!e.shiftKey&&!e.nativeEvent.isComposing&&available)onChange(suggestion);}}/>
    {available&&<span id={`${id}-hint`} className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">本文の候補 · Tabで確定<button type="button" tabIndex={-1} className="underline underline-offset-2" onClick={()=>onChange(suggestion)}>採用</button></span>}
  </span>;
}

export function CanvasChart({table,column,columns,type,unit}: {table:CanvasTable;column:number;columns?:number[];type:"bar"|"line";unit:string}) {
  const selected=columns??[column], colors=["#22c55e","#38bdf8","#f59e0b","#a78bfa","#fb7185","#2dd4bf"];
  const series=selected.map(c=>table.rows.map(row=>canvasNumber(row[c]??"")));
  const valid=series.flat().filter((v):v is number=>v!==null);
  if(!valid.length)return <p role="status">この列には描画できる数値がありません。元データを確認してください。</p>;
  const low=Math.min(0,...valid),high=Math.max(0,...valid),range=high-low||1;
  const y=(v:number)=>220-(v-low)/range*170;
  const step=640/Math.max(table.rows.length,1),x=(i:number)=>65+step*(i+.5);
  return <svg viewBox="0 0 760 280" role="img" aria-label={`${table.headers[column]}の${type==="bar"?"棒":"折れ線"}グラフ。単位：${unit}`} className="w-full rounded border bg-background">
    {selected.map((c,s)=><text key={c} x={15+s*125} y="22" fill={colors[s]} fontSize="11">{table.headers[c]?.slice(0,12)}（{unit}）</text>)}
    {[0,1,2,3,4].map(t=>{const value=low+(high-low)*t/4;return <g key={t}><line x1="65" x2="720" y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".15"/><text x="58" y={y(value)+4} textAnchor="end" fill="currentColor" fontSize="10">{new Intl.NumberFormat("ja",{notation:"compact",maximumFractionDigits:1}).format(value)}</text></g>;})}
    <line x1="65" x2="720" y1={y(0)} y2={y(0)} stroke="currentColor" opacity=".5"/>
    {series.map((values,s)=>values.map((value,i)=><g key={`${s}-${i}`}>
      {value!==null && (type==="bar"?<rect x={x(i)-step*.32+s*step*.64/selected.length} y={Math.min(y(value),y(0))} width={Math.max(1,step*.64/selected.length)} height={Math.max(1,Math.abs(y(value)-y(0)))} fill={colors[s]}><title>{`${table.headers[selected[s]]} ${table.rows[i][0]}: ${value.toLocaleString()} ${unit}`}</title></rect>:<>
        {i>0 && values[i-1]!==null && <line x1={x(i-1)} y1={y(values[i-1]!)} x2={x(i)} y2={y(value)} stroke={colors[s]} strokeDasharray={s?`${s*3} 3`:undefined} strokeWidth="3"/>}
        <circle cx={x(i)} cy={y(value)} r="4" fill={colors[s]}><title>{`${table.headers[selected[s]]} ${table.rows[i][0]}: ${value.toLocaleString()} ${unit}`}</title></circle>
      </>)}
      {s===0&&i%Math.max(1,Math.ceil(values.length/10))===0&&<text x={x(i)} y="245" textAnchor="middle" fill="currentColor" fontSize="10">{table.rows[i][0].slice(0,12)}</text>}
    </g>))}
  </svg>;
}

export function CanvasPanel({threadId,initialContent,onClose}:{threadId:string;initialContent?:string;onClose:()=>void}) {
  const [doc,setDoc]=useState<CanvasDocument>({threadId,title:"レポート",content:initialContent??"",unit:"",period:"",source:"",chartType:"bar",tableIndex:0,valueColumn:1,version:0});
  const [saved,setSaved]=useState("");
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[editing,setEditing]=useState(false);
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  const [undo,setUndo]=useState<CanvasDocument[]>([]),[redo,setRedo]=useState<CanvasDocument[]>([]);
  const [library,setLibrary]=useState<Array<{threadId:string;title:string;updatedAt?:string}>|null>(null),[search,setSearch]=useState("");
  const [instruction,setInstruction]=useState("");
  const [exporting,setExporting]=useState(false);
  const reportRef=useRef<HTMLDivElement>(null),updating=useRef(false);
  function changeDoc(next:CanvasDocument){setUndo(items=>[doc,...items].slice(0,20));setRedo([]);setDoc(next);}
  function step(direction:"undo"|"redo") {const next=canvasStep(doc,undo,redo,direction);setDoc(next.doc);setUndo(next.past);setRedo(next.future);setInstruction("");setNotice(direction==="undo"?"前の内容に戻しました。「更新」で保存できます。":"次の内容へ進みました。「更新」で保存できます。");}
  async function loadCollection() {
    setError("");
    try{const response=await fetch("/api/canvas?list=1",{cache:"no-store"});const data=await response.json();if(!response.ok)throw Error(data.error);setLibrary(data.items);}catch{setError("一覧を読み込めませんでした。");}
  }
  const dirty=JSON.stringify(doc)!==saved||!!instruction.trim();
  const tables=useMemo(()=>canvasTables(doc.content),[doc.content]);
  const suggestions=useMemo(()=>canvasMetadataSuggestions(doc.content),[doc.content]);
  const missing=[!doc.unit.trim()?"単位":"",!doc.period.trim()?"対象期間":"",!doc.source.trim()?"出典":""].filter(Boolean);
  const table=tables[doc.tableIndex];
  const canExportChart=!!table&&!missing.length&&(doc.valueColumns??[doc.valueColumn]).every(c=>c<table.headers.length)&&table.rows.some(row=>(doc.valueColumns??[doc.valueColumn]).some(c=>canvasNumber(row[c]??"")!==null));
  async function exportPng() {
    const svg=reportRef.current?.querySelector("svg");
    if(!svg||!table||!canExportChart)return;
    setExporting(true);setError("");
    try{await exportCanvasChart(svg,doc.title,`単位：${doc.unit}　対象期間：${doc.period}　出典：${doc.source}\n${table.headers.join(" / ")}\n${table.rows.map(row=>row.join(" / ")).join("\n")}`);setNotice("グラフ画像（PNG）を出力しました。");}
    catch{setError("グラフ画像を出力できませんでした。");}finally{setExporting(false);}
  }
  useEffect(()=>{
    const controller=new AbortController();
    void (async()=>{
      try {
        const response=await fetch(`/api/canvas?threadId=${encodeURIComponent(threadId)}&history=1`,{cache:"no-store",signal:controller.signal});
        const data=await response.json();
        if(!response.ok)throw Error(data.error||"読み込めませんでした。");
        if(controller.signal.aborted)return;
        setUndo(initialContent===undefined?(data.history??[]):data.item?[data.item,...(data.history??[])]:[]);setRedo([]);
        if(data.item){setSaved(JSON.stringify(data.item));setDoc(initialContent===undefined?data.item:{...data.item,title:"レポート",content:initialContent,unit:"",period:"",source:"",chartType:"bar",tableIndex:0,valueColumn:1,valueColumns:undefined});}
        else setSaved(JSON.stringify({threadId,title:"レポート",content:"",unit:"",period:"",source:"",chartType:"bar",tableIndex:0,valueColumn:1,version:0}));
      }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"読み込めませんでした。");}
      finally{if(!controller.signal.aborted)setLoading(false);}
    })();
    return()=>controller.abort();
  },[threadId,initialContent]);
  useEffect(()=>{
    const warn=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue="";}};
    const navigate=(event:MouseEvent)=>{
      const link=(event.target as Element)?.closest?.("a");
      if(!dirty||!link||link.target==="_blank"||link.hasAttribute("download")||link.href===location.href||link.getAttribute("href")?.startsWith("#"))return;
      if(!window.confirm("Canvasに未保存の変更があります。破棄して移動しますか？")){event.preventDefault();event.stopPropagation();}
    };
    window.addEventListener("beforeunload",warn);document.addEventListener("click",navigate,true);
    return()=>{window.removeEventListener("beforeunload",warn);document.removeEventListener("click",navigate,true);};
  },[dirty]);
  async function save() {
    if(updating.current)return;
    updating.current=true;setBusy(true);setError("");setNotice("");
    try {
      const item=await updateCanvas(doc,instruction);
      const data={item};
      if(instruction.trim()){setUndo(items=>[doc,...items].slice(0,20));setRedo([]);}
      setDoc(data.item);setSaved(JSON.stringify(data.item));setInstruction("");setEditing(false);setNotice("更新しました。表示中のレポートに反映・保存済みです。");
      requestAnimationFrame(()=>reportRef.current?.scrollIntoView({behavior:"smooth",block:"start"}));
    }catch(cause){setError(cause instanceof Error?cause.message:"保存できませんでした。");}finally{updating.current=false;setBusy(false);}
  }
  const input="w-full rounded border border-slate-400 bg-background p-2 text-sm";
  return <aside aria-label="Canvasレポート" className="fixed inset-0 z-50 flex h-full min-h-0 flex-col overflow-hidden border-l-2 border-slate-500 bg-background shadow-xl lg:static lg:z-auto lg:w-[48%] lg:min-w-[360px] lg:shrink-0">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b p-3">
      <h2 className="font-semibold">Canvas {dirty&&!loading&&<span className="text-xs text-muted-foreground">未保存</span>}</h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded border px-3 py-1 text-sm" onClick={()=>setEditing(!editing)}>{editing?"レポート表示":"直接編集"}</button>
        <button type="button" aria-label="戻る（Undo）" title="戻る（Undo）" disabled={!undo.length||loading||busy} className="rounded border px-3 py-1 text-sm disabled:opacity-50" onClick={()=>step("undo")}><Undo2 className="inline h-4 w-4"/> 戻る</button>
        <button type="button" aria-label="進む（Redo）" title="進む（Redo）" disabled={!redo.length||loading||busy} className="rounded border px-3 py-1 text-sm disabled:opacity-50" onClick={()=>step("redo")}><Redo2 className="inline h-4 w-4"/> 進む</button>
        <button type="button" className="rounded border px-3 py-1 text-sm" onClick={()=>void loadCollection()}>本人の一覧</button>
        <button type="button" disabled={loading||busy} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50" onClick={()=>void save()}>{busy?"更新中…":"更新"}</button>
        <button type="button" disabled={busy} className="rounded border px-3 py-1 text-sm" onClick={()=>{if(!dirty||window.confirm("未保存の変更を破棄して閉じますか？"))onClose();}}>閉じる</button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" aria-label="Canvasの出力メニュー" title="出力メニュー" disabled={loading||busy||exporting} className="rounded border p-2 disabled:opacity-50"><MoreHorizontal className="h-5 w-5"/></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[60] w-64">
            <DropdownMenuLabel>Canvasを出力</DropdownMenuLabel>
            <DropdownMenuItem disabled={editing} onSelect={()=>{try{if(reportRef.current)printCanvas(reportRef.current,doc.title);}catch(cause){setError((cause as Error).message);}}}><Printer className="mr-2 h-4 w-4"/>印刷・PDFに保存</DropdownMenuItem>
            <DropdownMenuItem disabled={!canExportChart} onSelect={()=>void exportPng()}><ImageDown className="mr-2 h-4 w-4"/>グラフ画像（PNG）を保存</DropdownMenuItem>
            <DropdownMenuItem onSelect={()=>{void navigator.clipboard.writeText(`# ${doc.title}\n\n${doc.content}\n\n単位：${doc.unit}\n対象期間：${doc.period}\n出典：${doc.source}`).then(()=>setNotice("本文をコピーしました。"),()=>setError("コピーできませんでした。"));}}><Copy className="mr-2 h-4 w-4"/>本文をコピー</DropdownMenuItem>
            <DropdownMenuSeparator/>
            <p className="px-2 py-1 text-xs text-muted-foreground">表示中の内容を出力します。PDFは印刷画面で「PDFに保存」を選択してください。</p>
            {editing&&<p className="px-2 py-1 text-xs text-muted-foreground">印刷するにはレポート表示へ切り替えてください。</p>}
            {!canExportChart&&<p className="px-2 py-1 text-xs text-muted-foreground">PNGはグラフ表示後に利用できます。</p>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 pb-10">
      {loading&&<p role="status">保存したCanvasを読み込み中…</p>}
      {error&&<p role="alert" className="text-sm text-red-500">{error}</p>}
      {notice&&<p role="status" className="text-sm">{notice}</p>}
      <p className="text-xs text-muted-foreground">依頼文を入力し「更新」で修正・反映・保存します。閉じ直す必要はありません。戻る・進むは20操作まで、開き直した場合は直前5回の保存内容へ戻れます。</p>
      {library&&<section className="space-y-2 rounded border p-3"><h3>本人のCanvas一覧（1チャットにつき1件）</h3><input aria-label="Canvas一覧を検索" className={input} placeholder="タイトルで検索" value={search} onChange={e=>setSearch(e.target.value)}/>{library.filter(item=>item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item=><a key={item.threadId} className="block underline" href={`/chat/${encodeURIComponent(item.threadId)}`}>{item.title} {item.updatedAt?new Date(item.updatedAt).toLocaleString("ja-JP"):""}</a>)}{!library.length&&<p>保存済みのCanvasはありません。</p>}<p className="text-xs">チャットへ移動し「このチャットのCanvasを開く」で再表示できます。</p><button onClick={()=>setLibrary(null)}>一覧を閉じる</button></section>}
      <section className="space-y-2 rounded border border-slate-400 p-3"><h3 className="font-semibold">Canvasへの依頼</h3><p className="text-xs text-muted-foreground">例：結論を先頭にして、読みやすい営業レポートに。入力後、「更新」を押すとAIで修正して反映・保存します。</p><textarea aria-label="Canvasへの依頼" className={input} maxLength={2000} value={instruction} disabled={loading||busy} onChange={e=>setInstruction(e.target.value)}/><button className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={loading||busy} onClick={()=>void save()}>{busy?"更新中…":"更新"}</button><p className="text-xs text-muted-foreground">依頼文がある時のみAIを呼び出します。結果は「戻る」で戻せます。</p></section>
      <div ref={reportRef} className="space-y-4">
      <label className="block text-sm">タイトル<input className={input} maxLength={120} value={doc.title} disabled={loading||busy} onChange={e=>changeDoc({...doc,title:e.target.value})}/></label>
      {editing?<label className="block text-sm">本文（Markdown）<textarea className={`${input} min-h-[24rem] font-mono`} maxLength={60000} disabled={loading||busy} value={doc.content} onChange={e=>changeDoc({...doc,content:e.target.value})}/></label>:
        <article className="prose prose-sm max-w-none overflow-x-auto rounded-lg border border-slate-400 bg-muted/20 p-5 dark:prose-invert"><h1>{doc.title}</h1><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:()=>null,a:({children,href})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>}}>{doc.content||"回答の「Canvasで開く」から取り込むか、直接編集で本文を入力してください。"}</ReactMarkdown></article>}
      <fieldset disabled={loading||busy} aria-label="グラフ" className="space-y-3 rounded-lg border border-slate-400 p-4">
        <h3 className="font-semibold">グラフ</h3>
        <p className="text-xs text-muted-foreground">本文の表を使用します。先頭列を横軸とし、数値列を選択してください。最大100行。未取得・空欄・単位付き文字列は描画せず、折れ線は欠測箇所で途切れます。</p>
        <p className="text-xs text-muted-foreground">薄文字は本文からの入力候補です。入力欄でTabを押すと確定して次の項目へ移動します。</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">対象の表<select className={input} value={doc.tableIndex} onChange={e=>changeDoc({...doc,tableIndex:Number(e.target.value),valueColumn:1,valueColumns:undefined})}>{tables.map((t,i)=><option key={i} value={i}>表{i+1}：{t.headers.join(" / ")}</option>)}</select></label>
          <label className="text-sm">数値列<select className={input} value={doc.valueColumn} onChange={e=>changeDoc({...doc,valueColumn:Number(e.target.value),valueColumns:undefined})}>{table?.headers.slice(1).map((h,i)=><option key={i} value={i+1}>{h}</option>)}</select></label>
          <label className="text-sm" htmlFor="canvas-unit">単位<CanvasSuggestionInput id="canvas-unit" className={input} maxLength={40} placeholder="例：円、件、%" value={doc.unit} suggestion={suggestions.unit} onChange={value=>changeDoc({...doc,unit:value})}/></label>
          <label className="text-sm" htmlFor="canvas-period">対象期間<CanvasSuggestionInput id="canvas-period" className={input} maxLength={120} placeholder="例：2026年4月〜9月" value={doc.period} suggestion={suggestions.period} onChange={value=>changeDoc({...doc,period:value})}/></label>
        </div>
        {table&&<div data-no-export className="flex flex-wrap gap-3 text-sm" role="group" aria-label="比較する系列"><span>比較する系列（同じ単位・最大6列）：</span>{table.headers.slice(1).map((h,i)=>{const columns=doc.valueColumns??[doc.valueColumn],c=i+1;return <label key={c}><input type="checkbox" checked={columns.includes(c)} disabled={!columns.includes(c)&&columns.length>=6} onChange={e=>{const next=e.target.checked?[...columns,c]:columns.filter(v=>v!==c);if(next.length)changeDoc({...doc,valueColumns:next,valueColumn:next[0]});}}/> {h}</label>;})}</div>}
        <label className="block text-sm" htmlFor="canvas-source">出典<CanvasSuggestionInput id="canvas-source" className={input} maxLength={2000} placeholder="資料名・URL・取得元など" value={doc.source} suggestion={suggestions.source} onChange={value=>changeDoc({...doc,source:value})}/></label>
        <div className="flex gap-2">{(["bar","line"] as const).map(type=><button type="button" key={type} aria-pressed={doc.chartType===type} className={`rounded border px-3 py-1 text-sm ${doc.chartType===type?"border-primary bg-muted":""}`} onClick={()=>changeDoc({...doc,chartType:type})}>{type==="bar"?"棒グラフ":"折れ線グラフ"}</button>)}</div>
        {!table?<p>本文にMarkdownの表がありません。</p>:missing.length?<p role="status" className="rounded border border-amber-500 p-2 text-sm">グラフ表示には「{missing.join("」「")}」の入力・確定が必要です。薄文字の候補は、Tabまたは「採用」で確定してください。</p>:(doc.valueColumns??[doc.valueColumn]).some(c=>c>=table.headers.length)?<p>数値列を選び直してください。</p>:<>
          <p className="break-words text-sm">単位：{doc.unit} ／ 対象期間：{doc.period}<br/>出典：{doc.source}</p>
          <div className="grid grid-cols-2 gap-2">{(doc.valueColumns??[doc.valueColumn]).map(column=>{const numbers=table.rows.map(row=>canvasNumber(row[column]??"")),valid=numbers.filter((n):n is number=>n!==null);return <div key={column} className="rounded border border-slate-400 p-3 text-sm"><strong>{table.headers[column]}</strong><p>取得済み：{valid.length} / {numbers.length}件</p>{valid.length>0&&<p>最大：{Math.max(...valid).toLocaleString()} {doc.unit}<br/>最小：{Math.min(...valid).toLocaleString()} {doc.unit}</p>}{valid.length<numbers.length&&<p className="text-amber-500">未取得あり</p>}</div>;})}</div>
          <CanvasChart table={table} column={doc.valueColumn} columns={doc.valueColumns} type={doc.chartType} unit={doc.unit}/>
          <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-xs"><caption className="mb-2 text-left font-medium">元データ（本文の表・最大100行）</caption><thead><tr>{table.headers.map((h,i)=><th key={i} className="border p-2">{h}</th>)}</tr></thead><tbody>{table.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j} className="border p-2">{cell||"未取得"}</td>)}</tr>)}</tbody></table></div>
        </>}
      </fieldset>
      </div>
    </div>
  </aside>;
}
