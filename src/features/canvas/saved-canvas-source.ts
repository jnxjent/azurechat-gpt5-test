import "server-only";
import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { CHAT_THREAD_ATTRIBUTE } from "@/features/chat-page/chat-services/models";
import { canvasSalesforceProofs } from "@/features/common/services/salesforce-history-access";
import { canvasIdFor } from "./canvas-service";
import { validateCanvas, type CanvasDocument } from "./canvas-rules";
import { CanvasSourceError, type Source } from "./canvas-source";

export async function savedCanvasSource(threadId:string, version?:number):Promise<{document:CanvasDocument;source:Source}> {
  if(!threadId || threadId.length>200)throw new CanvasSourceError(400,"Canvasを指定してください。");
  const userId=await userHashedId();
  const {resources}=await HistoryContainer().items.query({query:"SELECT c.id FROM c WHERE c.id=@id AND c.userId=@user AND c.type=@type AND c.isDeleted=false",parameters:[{name:"@id",value:threadId},{name:"@user",value:userId},{name:"@type",value:CHAT_THREAD_ATTRIBUTE}]},{partitionKey:userId}).fetchAll();
  if(!resources.length)throw new CanvasSourceError(404,"Canvasが見つかりません。");
  let item:CanvasDocument & {type:string;userId:string;canvasAccessSeal?:string};
  try { const {resource}=await HistoryContainer().item(canvasIdFor(threadId),userId).read<typeof item>(); if(!resource)throw Error(); item=resource; }
  catch { throw new CanvasSourceError(404,"先にCanvasの「更新」で保存してください。"); }
  if(item.type!=="USER_CANVAS" || item.userId!==userId || item.threadId!==threadId)throw new CanvasSourceError(404,"Canvasが見つかりません。");
  if(version!==undefined && item.version!==version)throw new CanvasSourceError(409,"Canvasが更新されています。開き直して共有してください。");
  let proofs:string[];
  try { proofs=await canvasSalesforceProofs(item,userId); }
  catch { throw new CanvasSourceError(422,"このCanvasの出典を確認できません。本人権限で取得した回答からCanvasを作成・保存してください。"); }
  const document=validateCanvas(item);
  delete document.sourceContent; delete document.sourceMessageIds;
  return {document,source:{provider:"salesforce",query:"",thread:threadId,proof:proofs[0],...(proofs.length>1?{proofs}:{}),savedCanvas:{threadId,version:item.version}}};
}
