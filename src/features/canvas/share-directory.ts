import "server-only";
import { getCanvasActor } from "./canvas-actor";
import { isSalesforceAllowedEmail } from "@/features/common/services/salesforce-access";
import { personalSalesforceBase,signSalesforceRequest,assertPersonalSalesforceResponse } from "@/features/common/services/salesforce-personal";
import { CanvasShareError,type CanvasShareUser } from "./shared-canvas-service";

/** SF permission-set membership and Department are authoritative; identities come from verified bindings. */
export async function salesforceShareDirectory():Promise<CanvasShareUser[]> {
  const user=await getCanvasActor();
  if(!user.salesforcePrincipal||!isSalesforceAllowedEmail(user.email))throw new CanvasShareError(403,"共有対象者を確認できません。");
  if(process.env.SF_PERSONAL_AUTH_METHOD!=="oauth"||process.env.SF_PERSONAL_SNAPSHOT_POLICY!=="strict")throw new CanvasShareError(503,"本人接続の設定を確認してください。");
  const url=new URL("/api/sf/share_people",personalSalesforceBase());
  if(url.protocol!=="https:")throw new CanvasShareError(503,"共有対象者の接続先を確認してください。");
  const headers=signSalesforceRequest({principal:user.salesforcePrincipal,email:user.email,thread:"",url},process.env.SF_PERSONAL_SIGNING_KEY??"");
  const response=await fetch(url,{headers:{...headers,"X-User-Email":user.email,"X-Chat-Thread-Id":""},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new CanvasShareError(503,"Salesforceの共有対象者を取得できません。本人接続と権限セットの設定をご確認ください。");
  assertPersonalSalesforceResponse(response,headers);
  const data=await response.json();
  if(data.ok!==true||!Array.isArray(data.items)||data.items.length>500||data.items.some((v:CanvasShareUser)=>!v||typeof v.principal!=="string"||!/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(v.principal)||typeof v.email!=="string"||typeof v.name!=="string"||typeof v.department!=="string"))throw new CanvasShareError(503,"共有対象者の情報を確認できません。");
  const users:CanvasShareUser[]=data.items.map((v:CanvasShareUser)=>({principal:v.principal.toLowerCase(),email:v.email.trim().toLowerCase(),name:v.name!.slice(0,120),department:v.department!.slice(0,120)})).filter((v:CanvasShareUser)=>v.principal.split(":")[0]===user.salesforcePrincipal!.split(":")[0].toLowerCase()&&isSalesforceAllowedEmail(v.email));
  if(new Set(users.map(v=>v.principal)).size!==users.length||new Set(users.map(v=>v.email)).size!==users.length)throw new CanvasShareError(503,"共有対象者の対応付けが重複しています。");
  return users;
}
