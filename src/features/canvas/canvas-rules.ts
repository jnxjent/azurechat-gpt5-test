export interface CanvasDocument {
  sourceMessageIds?: string[]; sourceContent?: string;
  threadId: string; title: string; content: string; unit: string; period: string; source: string;
  chartType: "bar" | "line"; tableIndex: number; valueColumn: number; valueColumns?: number[]; version: number;
}
export interface CanvasTable { headers: string[]; rows: string[][] }
/** The Salesforce report supplies explicit metadata along with its table. */
export function canvasImportedMetadata(content: string) {
  return content.startsWith("<!-- salesforce:monthly-report -->")
    ? canvasMetadataSuggestions(content) : {unit:"",period:"",source:""};
}
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
/** Context is restricted to the user turns preceding the selected answer. */
export function canvasChatContext(messages:ReadonlyArray<{role:string;content:string}>,content?:string):string {
  let end=messages.length;
  if(content!==undefined){for(let i=messages.length-1;i>=0;i--){if(messages[i].role==="assistant"&&messages[i].content===content){end=i;break;}}}
  return messages.slice(0,end).filter(message=>message.role==="user").slice(-4).reverse().map(message=>message.content).join("\n");
}

function canvasPeriodFromText(text:string):string {
  text=text.normalize("NFKC");
  const iso=text.match(/(\d{4}-\d{2}-\d{2})\s*[〜~～]\s*(\d{4}-\d{2}-\d{2})/);
  if(iso){const start=new Date(iso[1]),end=new Date(iso[2]);if(Number.isFinite(+start)&&Number.isFinite(+end)&&start<=end&&start.toISOString().slice(0,10)===iso[1]&&end.toISOString().slice(0,10)===iso[2])return `${iso[1]}〜${iso[2]}`;}
  const full=text.match(/(\d{4})年\s*(\d{1,2})月\s*(?:(\d{1,2})日)?\s*(?:[〜~～-]|から)\s*(?:(\d{4})年)?\s*(\d{1,2})月\s*(?:(\d{1,2})日)?/);
  const months=text.match(/(\d{4})年\s*(\d{1,2})\s*[〜~～-]\s*(\d{1,2})月/);
  if(!full&&!months){
    const single=text.match(/(\d{4})年\s*(\d{1,2})月(?!\s*\d|\s*[〜~～-]|\s*から)/);
    if(single&&!/[〜~～]|から/.test(text))return canvasPeriodFromText(`${single[1]}年${single[2]}〜${single[2]}月`);
    return "";
  }
  const year=Number((full??months)![1]),month=Number((full??months)![2]);
  const endYear=full?Number(full[4]||year):year,endMonth=Number(full?full[5]:months![3]);
  if(month<1||month>12||endMonth<1||endMonth>12)return "";
  const startDay=Number(full?.[3]||1),endDay=Number(full?.[6]||new Date(Date.UTC(endYear,endMonth,0)).getUTCDate());
  const date=(y:number,m:number,d:number)=>`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const start=date(year,month,startDay),end=date(endYear,endMonth,endDay);
  const startDate=new Date(start),endDate=new Date(end);
  if(!Number.isFinite(+startDate)||!Number.isFinite(+endDate)||startDate.toISOString().slice(0,10)!==start||endDate.toISOString().slice(0,10)!==end||start>end)return "";
  return `${start}〜${end}`;
}

function hasCanvasPeriodIntent(text:string):boolean {
  // Grouping/presentation changes retain the preceding period. A real new
  // period still blocks fallback even if it cannot yet be parsed (e.g. 来月).
  const periodText=text.normalize("NFKC")
    .replace(/(?:四半期|年度|年|月|週|日)(?:別|ごと)|毎(?:年|月|週|日)/g,"")
    .replace(/(?:同じ|同一)(?:の)?期間|(?:対象期間|期間)(?:は|を)?(?:そのまま|同じ|変えず|変更せず)/g,"");
  return /\d{4}|\d+\s*(?:年|月|週|日)|(?:今|来|先|昨|翌|前|再来)(?:年|月|週|日|期)|期間|年度|対象月|対象年|四半期|直近|過去/.test(periodText);
}

/** Prefer explicit report metadata, then offer candidates from the relevant chat. */
export function canvasMetadataSuggestions(content: string,context=""): {unit:string;period:string;source:string} {
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
  const visible=content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g,"");
  const headers=canvasTables(visible).map(table=>table.headers.join(" ")).join(" ");
  const units=Array.from(new Set(headers.match(/億円|万円|千円|円|USD|EUR|件|%/g)??[]));
  const monetary=units.filter(unit=>unit!=="件"&&unit!=="%");
  const inferredUnit=monetary.length===1?monetary[0]:units.length===1?units[0]:/商談金額/.test(visible+context)&&!monetary.length?"円":"";
  const periodContext=context.split("\n").find(hasCanvasPeriodIntent)??"";
  const period=canvasPeriodFromText(visible)||canvasPeriodFromText(periodContext);
  const inferSource=(text:string)=>/Salesforce|salesforce\.com|lightning\.force\.com/i.test(text)?"Salesforce":/SharePoint|sharepoint\.com/i.test(text)?"SharePoint":"";
  const source=inferSource(visible)||context.split("\n").map(inferSource).find(Boolean)||"";
  return {unit:values.unit.size===1?Array.from(values.unit)[0]:values.unit.size?"":inferredUnit,
    period:values.period.size===1?Array.from(values.period)[0]:values.period.size?"":period,
    source:values.source.size===1?Array.from(values.source)[0]:values.source.size?"":source};
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
  if(v.sourceMessageIds!==undefined&&(!Array.isArray(v.sourceMessageIds)||v.sourceMessageIds.length>40||v.sourceMessageIds.some(id=>typeof id!=="string"||!id||id.length>200)))throw new TypeError("Invalid Canvas sources");
  if(v.sourceContent!==undefined&&(typeof v.sourceContent!=="string"||v.sourceContent.length>60000))throw new TypeError("Invalid Canvas source");
  return Object.fromEntries([...Object.keys(limits),"version","chartType","tableIndex","valueColumn",...(v.valueColumns===undefined?[]:["valueColumns"]),...(v.sourceMessageIds===undefined?[]:["sourceMessageIds"]),...(v.sourceContent===undefined?[]:["sourceContent"])].map(key=>[key,v[key]])) as unknown as CanvasDocument;
}
