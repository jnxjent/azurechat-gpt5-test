import { CanvasDocument, validateCanvas } from "./canvas-rules";

/** One explicit update: rewrite when requested, then persist that exact result. */
export async function updateCanvas(document:CanvasDocument,instruction:string,request:typeof fetch=fetch):Promise<CanvasDocument> {
  let next=document;
  if(instruction.trim()) {
    const response=await request("/api/canvas/rewrite",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({document,instruction})});
    const data=await response.json();
    if(!response.ok)throw Error(data.error||"修正できませんでした。元の内容は変更していません。");
    next=validateCanvas({...document,content:data.content});
  }
  const response=await request("/api/canvas",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(next)});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||"更新内容を保存できませんでした。依頼文は残っています。");
  return validateCanvas(data.item);
}
