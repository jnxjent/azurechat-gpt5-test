import "server-only";
import {createHash,createHmac,timingSafeEqual} from "node:crypto";
import {HistoryContainer} from "@/features/common/services/cosmos";
import type {CanvasActor} from "@/features/canvas/canvas-actor";
import {canvasNotificationTargets} from "@/features/canvas/shared-canvas-service";

const partition="CANVAS_TEAMS_ROUTE";
type Route={id:string;userId:typeof partition;type:"CANVAS_TEAMS_ROUTE";ttl:number;principal:string;email:string;botId:string;conversationId:string;updatedAt:string;seal:string};
const botId=()=>process.env.TEAMS_BOT_ID?.trim()||process.env.AZURE_AD_CLIENT_ID?.trim()||"";
function id(principal:string){return "canvas-teams-"+createHash("sha256").update(JSON.stringify([botId(),principal])).digest("hex");}
function seal(route:Omit<Route,"seal">|Route){const {id,userId,type,ttl,principal,email,botId,conversationId,updatedAt}=route;const secret=process.env.SF_PERSONAL_SIGNING_KEY??"";if(secret.length<32)throw Error("Missing notification signature");return createHmac("sha256",secret).update("canvas-teams-route-v1:"+JSON.stringify({id,userId,type,ttl,principal,email,botId,conversationId,updatedAt})).digest("hex");}

/** Called only after SDK authentication and the authoritative roster check. */
export async function rememberTeamsCanvasConversation(actor:CanvasActor,conversationId:string) {
  if(!botId()||!actor.salesforcePrincipal||!conversationId||conversationId.length>2000)return;
  const route:Route={id:id(actor.salesforcePrincipal),userId:partition,type:partition,ttl:90*24*60*60,principal:actor.salesforcePrincipal,email:actor.email,botId:botId(),conversationId,updatedAt:new Date().toISOString(),seal:""};route.seal=seal(route);
  try {await HistoryContainer().items.upsert(route);}catch {console.warn("[teams-canvas] Conversation notification registration unavailable");}
}
export type CanvasNotificationResult={sent:number;unavailable:number;failed:number;error?:string};
export async function notifyTeamsCanvasShare(shareId:string,message:unknown):Promise<CanvasNotificationResult> {
  const result:CanvasNotificationResult={sent:0,unavailable:0,failed:0};
  try {
    if(process.env.TEAMS_ENABLED!=="true"||!botId()||process.env.TEAMS_SKIP_AUTH?.trim().toLowerCase()==="true")throw Error("Teams notifications unavailable");
    if(message!==undefined&&(typeof message!=="string"||new TextEncoder().encode(message).length>4000))throw Error("Invalid message");
    const targets=await canvasNotificationTargets(shareId);
    result.unavailable=targets.unavailable;
    const base=new URL(process.env.NEXTAUTH_URL??"");if(base.protocol!=="https:"||base.username||base.password)throw Error("Invalid report URL");
    const url=new URL(`/canvas/shared/${shareId}`,base).href;
    for(const recipient of targets.readers) {
      try {
        // Re-read ACL before every delivery so concurrent unsharing stops sends.
        const current=await canvasNotificationTargets(shareId,targets.revision);
        if(current.revision!==targets.revision||!current.readers.some(v=>v.principal===recipient.principal&&v.email===recipient.email)){result.unavailable++;continue;}
        const {resource}=await HistoryContainer().item(id(recipient.principal),partition).read<Route>();
        if(!resource){result.unavailable++;continue;}
        const age=Date.now()-Date.parse(resource.updatedAt);
        const valid=resource.id===id(recipient.principal)&&resource.userId===partition&&resource.type===partition&&resource.principal===recipient.principal&&resource.email===recipient.email&&resource.botId===botId()&&typeof resource.conversationId==="string"&&resource.conversationId.length>0&&Number.isFinite(age)&&age>=0&&age<90*24*60*60*1000&&/^[a-f0-9]{64}$/.test(resource.seal)&&timingSafeEqual(Buffer.from(resource.seal,"hex"),Buffer.from(seal(resource),"hex"));
        if(!valid){result.unavailable++;continue;}
        const {app}=await (await import("./teams-app")).getTeamsRuntime();
        // The owner's explicitly entered sharing message is sent; no SF report
        // body or financial data is copied into a proactive notification.
        await app.send(resource.conversationId,{
          type:"message",
          text:`${targets.owner.name??targets.owner.email}さんからCanvasが共有されました。${typeof message==="string"&&message.trim()?"\n\n"+message.trim():""}`,
          attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:{
            type:"AdaptiveCard",version:"1.4",
            body:[{type:"TextBlock",text:"共有レポート",weight:"Bolder",wrap:true}],
            actions:[{type:"Action.Submit",title:"Teamsで操作",data:{feature:"ac.canvas",operation:"open",shareId}},
              {type:"Action.OpenUrl",title:"レポートを開く",url},{type:"Action.OpenUrl",title:"コメントを確認",url:url+"#comments"}],
          }}],
        });
        result.sent++;
      }catch(error){if((error as {code?:number}).code===404)result.unavailable++;else result.failed++;}
    }
  }catch {result.error="共有は保存しましたが、Teams通知を完了できませんでした。";}
  return result;
}
