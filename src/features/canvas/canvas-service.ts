import "server-only";
import { createHash } from "node:crypto";
import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
export const canvasIdFor=(threadId:string)=>`canvas-${createHash("sha256").update(threadId).digest("hex")}`;
export async function deleteCanvasForThread(threadId:string) {
  const userId=await userHashedId(),id=canvasIdFor(threadId);
  try {
    const {resource}=await HistoryContainer().item(id,userId).read<{type:string;userId:string;threadId:string;_etag?:string}>();
    if(!resource)return;
    if(resource.type!=="USER_CANVAS"||resource.userId!==userId||resource.threadId!==threadId||!resource._etag)throw Error("Invalid Canvas owner");
    await HistoryContainer().item(id,userId).delete({accessCondition:{type:"IfMatch",condition:resource._etag}});
  }catch(error){if((error as {code:number}).code!==404)throw error;}
}
