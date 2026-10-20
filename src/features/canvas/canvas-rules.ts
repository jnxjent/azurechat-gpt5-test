export interface CanvasDocument {
  threadId: string; title: string; content: string; unit: string; period: string; source: string;
  chartType: "bar" | "line"; tableIndex: number; valueColumn: number; valueColumns?: number[]; version: number;
}
export interface CanvasTable { headers: string[]; rows: string[][] }
export function canvasStep(doc:CanvasDocument,past:CanvasDocument[],future:CanvasDocument[],direction:"undo"|"redo") {
  const from=direction==="undo"?past:future;
  if(!from.length)return {doc,past,future};
  const next={...from[0],version:doc.version};
  return direction==="undo"?{doc:next,past:past.slice(1),future:[doc,...future].slice(0,20)}:{doc:next,past:[doc,...past].slice(0,20),future:future.slice(1)};
}
export function canvasUpdateDocument(doc:CanvasDocument,proposal:{base:string;content:string}|null):CanvasDocument {
  if(!proposal)return doc;
  if(proposal.base!==JSON.stringify(doc))throw new TypeError("文書が変わりました。修正案を作り直してください。");
  return validateCanvas({...doc,content:proposal.content});
}
/** Suggest only explicitly labelled, unambiguous metadata in the document. No model call. */
export function canvasMetadataSuggestions(content: string): {unit:string;period:string;source:string} {
  const values={unit:new Set<string>(),period:new Set<string>(),source:new Set<string>()};
  let fenced=false;
  for(const line of content.split(/\r?\n/)) {
    if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;continue;}
    if(fenced)continue;
    const text=line.replace(/\*\*/g,"").replace(/^\s*(?:[-*+]\s+|#{1,6}\s+)/,"").trim();
    const match=text.match(/^(単位|対象期間|期間|出典|データ出典)\s*[:：]\s*(.+)$/);
    if(!match)continue;
    const key=match[1]==="単位"?"unit":["対象期間","期間"].includes(match[1])?"period":"source";
    const value=match[2].trim();
    const limit=key==="unit"?40:key==="period"?120:2000;
    if(value.length<=limit&&!/^(不明|未取得|未記載|なし|N\/?A|[-—]+)$/i.test(value))values[key].add(value);
  }
  return {unit:values.unit.size===1?Array.from(values.unit)[0]:"",period:values.period.size===1?Array.from(values.period)[0]:"",source:values.source.size===1?Array.from(values.source)[0]:""};
}
export function canvasTables(content: string): CanvasTable[] {
  const result: CanvasTable[] = [];
  let fenced = false;
  const lines = content.split(/\r?\n/);
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(x => x.trim().replace(/\\\|/g, "|"));
  for (let i=0; i<lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fenced=!fenced; continue; }
    if (fenced || !lines[i].includes("|") || !lines[i+1]) continue;
    const separators=cells(lines[i+1]);
    if (separators.length<2 || !separators.every(x=>/^:?-{3,}:?$/.test(x))) continue;
    const headers=cells(lines[i]);
    if (headers.length!==separators.length) continue;
    const rows: string[][]=[];
    i+=2;
    while(i<lines.length && lines[i].trim() && lines[i].includes("|")) {
      const row=cells(lines[i]);
      if(row.length===headers.length) rows.push(row);
      i++;
    }
    i--;
    result.push({headers,rows:rows.slice(0,100)});
    if(result.length===10) break;
  }
  return result;
}
/** Missing values, currency suffixes and percentages are never silently coerced. */
export function canvasNumber(value: string): number | null {
  const text=value.normalize("NFKC").trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const number=Number(text.replace(/,/g,""));
  return Number.isFinite(number) && Math.abs(number)<=Number.MAX_SAFE_INTEGER ? number : null;
}
export function validateCanvas(value: unknown): CanvasDocument {
  if (!value || typeof value!=="object") throw new TypeError("文書が正しくありません。");
  const v=value as Record<string,unknown>;
  const limits={threadId:200,title:120,content:60000,unit:40,period:120,source:2000};
  for (const [key,limit] of Object.entries(limits)) {
    if(typeof v[key]!=="string" || (v[key] as string).length>limit) throw new TypeError("入力内容が長すぎるか、形式が正しくありません。");
  }
  if (!(v.threadId as string).trim() || !(v.title as string).trim() || new TextEncoder().encode(v.content as string).length>120000) throw new TypeError("タイトル・文書の内容を確認してください。");
  if (!Number.isInteger(v.version) || Number(v.version)<0 || !["bar","line"].includes(String(v.chartType)) ||
      !Number.isInteger(v.tableIndex) || Number(v.tableIndex)<0 || Number(v.tableIndex)>9 ||
      !Number.isInteger(v.valueColumn) || Number(v.valueColumn)<1 || Number(v.valueColumn)>100) throw new TypeError("グラフ設定が正しくありません。");
  if(v.valueColumns!==undefined && (!Array.isArray(v.valueColumns)||v.valueColumns.length<1||v.valueColumns.length>6||v.valueColumns.some(c=>!Number.isInteger(c)||c<1||c>100)||new Set(v.valueColumns).size!==v.valueColumns.length))throw new TypeError("比較する系列は1〜6列を選択してください。");
  return Object.fromEntries([...Object.keys(limits),"version","chartType","tableIndex","valueColumn",...(v.valueColumns===undefined?[]:["valueColumns"])].map(key=>[key,v[key]])) as unknown as CanvasDocument;
}
