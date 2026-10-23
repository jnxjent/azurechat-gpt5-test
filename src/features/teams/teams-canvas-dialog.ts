import "server-only";
import {createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {getCurrentUser} from "@/features/auth-page/helpers";
import {withCanvasActor,type CanvasActor} from "@/features/canvas/canvas-actor";
import {CanvasShareError,createSharedCanvas,getSharedCanvas} from "@/features/canvas/shared-canvas-service";

type Claim={purpose:"launch"|"access";principal:string;email:string;id:string;query?:string;accountId?:string;expires:number;origin:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function origin(){const u=new URL(process.env.NEXTAUTH_URL??"");if(u.protocol!=="https:")throw new CanvasShareError(503,"接続先設定を確認してください。");return u.origin;}
function sign(raw:string){const key=process.env.SF_PERSONAL_SIGNING_KEY??"";if(key.length<32)throw new CanvasShareError(503,"署名設定を確認してください。");return createHmac("sha256",key).update("teams-canvas-dialog-v1:"+raw).digest("hex");}
function encode(claim:Claim){const raw=Buffer.from(JSON.stringify(claim)).toString("base64url");return raw+"."+sign(raw);}
function decode(token:unknown,purpose:Claim["purpose"]):Claim {
  try {
    if(typeof token!=="string"||token.length>16000)throw Error();
    const [raw,seal,...rest]=token.split(".");if(rest.length||!/^[a-f0-9]{64}$/.test(seal??"")||!timingSafeEqual(Buffer.from(seal,"hex"),Buffer.from(sign(raw),"hex")))throw Error();
    const claim=JSON.parse(Buffer.from(raw,"base64url").toString("utf8")) as Claim,now=Math.floor(Date.now()/1000);
    if(claim.purpose!==purpose||claim.origin!==origin()||!uuid.test(claim.id)||!Number.isSafeInteger(claim.expires)||claim.expires<now||claim.expires>now+1800||typeof claim.email!=="string"||!/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(claim.principal))throw Error();
    if(claim.query!==undefined&&(typeof claim.query!=="string"||!claim.query.trim()||claim.query.length>1000))throw Error();
    if(claim.accountId!==undefined&&!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(claim.accountId))throw Error();
    return claim;
  }catch{throw new CanvasShareError(401,"Teamsのカードから開き直してください。");}
}
/** A launch is not a login: exchanging it requires the same Microsoft Web identity. */
export function canvasDialogUrl(actor:CanvasActor,options:{id?:string;query?:string;accountId?:string}) {
  if(!actor.salesforcePrincipal)throw new CanvasShareError(403,"本人を確認できません。");
  const claim:Claim={purpose:"launch",principal:actor.salesforcePrincipal.toLowerCase(),email:actor.email.trim().toLowerCase(),id:options.id??randomUUID(),query:options.query,accountId:options.accountId,expires:Math.floor(Date.now()/1000)+300,origin:origin()};
  return origin()+"/teams/canvas#launch="+encode(claim);
}
export async function authorizeCanvasDialog(launch:unknown) {
  const claim=decode(launch,"launch"),user=await getCurrentUser();
  if(user.salesforcePrincipal?.toLowerCase()!==claim.principal||user.email.trim().toLowerCase()!==claim.email)throw new CanvasShareError(403,"Teamsと同じMicrosoftアカウントでログインしてください。");
  return {token:encode({...claim,purpose:"access",expires:Math.floor(Date.now()/1000)+1800}),id:claim.id};
}
export function dialogRequestClaim(request:Request){return decode(request.headers.get("Authorization")?.replace(/^Bearer /,""),"access");}
/** Scoped bearer only authorizes this report and people lookup, never general chat APIs. */
export async function withCanvasRequest<T>(request:Request,id:string|undefined,operation:()=>Promise<T>):Promise<T> {
  if(!request.headers.has("Authorization"))return operation();
  const claim=dialogRequestClaim(request);
  if(id!==undefined&&claim.id!==id)throw new CanvasShareError(403,"別のレポートは操作できません。");
  return withCanvasActor({email:claim.email,salesforcePrincipal:claim.principal},operation);
}
export async function prepareCanvasDialog(request:Request) {
  const claim=dialogRequestClaim(request);
  return withCanvasRequest(request,claim.id,async()=>{
    try {await getSharedCanvas(claim.id);return {id:claim.id};}
    catch(error){if(!(error instanceof CanvasShareError)||error.status!==404||!claim.query)throw error;}
    try {await createSharedCanvas(claim.query,{id:claim.id,accountId:claim.accountId});}
    catch(error){if((error as {code?:number}).code!==409)throw error;await getSharedCanvas(claim.id);}
    return {id:claim.id};
  });
}
