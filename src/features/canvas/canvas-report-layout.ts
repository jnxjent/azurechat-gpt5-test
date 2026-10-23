import { fromMarkdown } from "mdast-util-from-markdown";
import type { CanvasDocument } from "./canvas-rules";

/** Parse Markdown headings, including inline formatting, rather than guessing from lines. */
export function canvasReportLayout(document:CanvasDocument) {
  const tree=fromMarkdown(document.content);
  const first=tree.children.find(node=>!(node.type==="html"&&node.value.trim().startsWith("<!--")&&node.value.trim().endsWith("-->")));
  if(first?.type!=="heading")return {title:document.title,body:document.content};
  const text=(node:unknown):string=>{
    const n=node as {value?:string;alt?:string;children?:unknown[]};
    return n.children?n.children.map(text).join(""):n.value??n.alt??"";
  };
  const heading=text(first).trim();
  const title=["レポート","Salesforceレポート"].includes(document.title)?heading||document.title:document.title;
  const start=first.position?.start.offset,end=first.position?.end.offset;
  return {title,body:title===heading&&start!==undefined&&end!==undefined?document.content.slice(0,start)+document.content.slice(end):document.content};
}
