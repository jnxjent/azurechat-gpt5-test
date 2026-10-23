import "server-only";
import { createHmac,randomUUID,timingSafeEqual } from "node:crypto";
import type { IAdaptiveCard } from "@microsoft/teams.cards";
import { withCanvasActor,type CanvasActor } from "@/features/canvas/canvas-actor";
import { getSharedCanvas,changeCanvasComment,CanvasShareError } from "@/features/canvas/shared-canvas-service";
import { isSalesforceAllowedEmail } from "@/features/common/services/salesforce-access";

export type CanvasTeamsActivity={channelId?:unknown;text?:unknown;value?:unknown;conversation?:{id?:string;conversationType?:unknown;tenantId?:unknown};from?:{id?:string;aadObjectId?:unknown};channelData?:{tenant?:{id?:unknown}}};
export type CanvasTeamsApi={conversations:{members:(id:string)=>{getById:(id:string)=>Promise<{id?:string;aadObjectId?:string;tenantId?:string;email?:string;userPrincipalName?:string}>}}};
export type TeamsCanvasReply={text?:string;card?:IAdaptiveCard};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const feature="ac.canvas";
class TeamsCanvasError extends Error {}
function baseUrl() {
  const url=new URL(process.env.NEXTAUTH_URL??"");
  if(url.protocol!=="https:"||url.username||url.password)throw new TeamsCanvasError("共有レポートの接続先設定を確認してください。");
  return url;
}
function dataObject(value:unknown):Record<string,unknown>|null {return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;}
export function isTeamsCanvasSubmission(value:unknown) {return dataObject(value)?.feature===feature;}
export function teamsCanvasLink(text:unknown):string|null {
  if(typeof text!=="string")return null;
  // URL tokenization only; report identity is subsequently parsed and origin-checked.
  for(const token of text.match(/https:\/\/[^\s<>"\]]+/g)??[]) {
    try {
      const url=new URL(token),parts=url.pathname.split("/");
      if(parts.length===4&&parts[1]==="canvas"&&parts[2]==="shared"&&uuid.test(parts[3])&&url.origin===baseUrl().origin&&!url.username&&!url.password&&!url.search&&!url.hash)return parts[3];
    }catch{}
  }
  return null;
}
export function isTeamsCanvasRequest(activity:CanvasTeamsActivity) {return isTeamsCanvasSubmission(activity.value)||Boolean(teamsCanvasLink(activity.text))||activity.text==="共有レポート";}

/** SDK-authenticated activity + authoritative conversation roster, never email/AAD IDs from card data. */
export async function resolveTeamsCanvasActor(activity:CanvasTeamsActivity,api:CanvasTeamsApi):Promise<CanvasActor> {
  if(process.env.TEAMS_SKIP_AUTH?.trim().toLowerCase()==="true")throw new TeamsCanvasError("認証を省略した環境では共有レポートを操作できません。");
  if(activity.channelId!=="msteams"||activity.conversation?.conversationType!=="personal")throw new TeamsCanvasError("共有レポートはAzureChatBOTとの個人チャットで操作してください。");
  const tenant=(process.env.TEAMS_TENANT_ID??process.env.AZURE_AD_TENANT_ID??"").trim().toLowerCase();
  const activityTenant=String(activity.channelData?.tenant?.id??activity.conversation?.tenantId??"").toLowerCase();
  if(!uuid.test(tenant)||activityTenant!==tenant||(activity.conversation?.tenantId&&String(activity.conversation.tenantId).toLowerCase()!==tenant)||!activity.conversation?.id||!activity.from?.id)throw new TeamsCanvasError("Teamsの所属組織と本人を確認できません。");
  const member=await api.conversations.members(activity.conversation.id).getById(activity.from.id);
  const oid=member.aadObjectId?.toLowerCase(),email=(member.email??member.userPrincipalName??"").trim().toLowerCase();
  if(!oid||!uuid.test(oid)||!isSalesforceAllowedEmail(email)||(member.tenantId&&member.tenantId.toLowerCase()!==tenant)||(activity.from.aadObjectId&&String(activity.from.aadObjectId).toLowerCase()!==oid))throw new TeamsCanvasError("TeamsとSalesforceの本人対応を確認できません。");
  const principal=`${tenant}:${oid}`;
  const registered=JSON.parse(process.env.SF_PERSONAL_USERS_JSON??"[]");
  if(!Array.isArray(registered)||!registered.some(v=>v?.principal?.toLowerCase()===principal&&v?.email?.trim().toLowerCase()===email))throw new TeamsCanvasError("Salesforce本人接続の利用者登録を確認してください。");
  return {salesforcePrincipal:principal,email};
}

type CardClaim={v:1;principal:string;conversation:string;shareId:string;revision:number;expires:number;nonce:string};
function key() {const value=process.env.SF_PERSONAL_SIGNING_KEY??"";if(value.length<32)throw new TeamsCanvasError("共有カードの署名設定を確認してください。");return value;}
function sign(raw:string) {return createHmac("sha256",key()).update("teams-canvas-card-v1:"+raw).digest("hex");}
function issue(actor:CanvasActor,conversation:string,shareId:string,revision:number) {
  const claim:CardClaim={v:1,principal:actor.salesforcePrincipal!,conversation,shareId,revision,expires:Math.floor(Date.now()/1000)+1800,nonce:randomUUID()};
  const raw=Buffer.from(JSON.stringify(claim)).toString("base64url");return raw+"."+sign(raw);
}
function verify(value:unknown,actor:CanvasActor,conversation:string,shareId:string):CardClaim {
  try {
    if(typeof value!=="string"||value.length>3000)throw Error();
    const [raw,seal,...rest]=value.split(".");if(rest.length||!seal||!/^[a-f0-9]{64}$/.test(seal)||!timingSafeEqual(Buffer.from(seal,"hex"),Buffer.from(sign(raw),"hex")))throw Error();
    const claim=JSON.parse(Buffer.from(raw,"base64url").toString("utf8")) as CardClaim;
    const now=Math.floor(Date.now()/1000);
    if(claim.v!==1||claim.principal!==actor.salesforcePrincipal||claim.conversation!==conversation||claim.shareId!==shareId||!Number.isSafeInteger(claim.revision)||claim.revision<1||!uuid.test(claim.nonce)||!Number.isSafeInteger(claim.expires)||claim.expires<now||claim.expires>now+1860)throw Error();
    return claim;
  }catch{throw new TeamsCanvasError("このカードは期限切れか、別の利用者・会話のものです。共有URLをもう一度送ってください。");}
}
type CanvasReport=Awaited<ReturnType<typeof getSharedCanvas>>;
function buildCard(actor:CanvasActor,conversation:string,shareId:string,report:CanvasReport,notice?:string):IAdaptiveCard {
  const token=issue(actor,conversation,shareId,report.revision),url=new URL(`/canvas/shared/${shareId}`,baseUrl()).href;
  // Conversation Submit follows the existing bot message path, where SF checks can finish before replying.
  const action=(operation:"refresh"|"post",title:string):NonNullable<IAdaptiveCard["actions"]>[number]=>({type:"Action.Submit",title,associatedInputs:operation==="post"?"auto":"none",data:{feature,operation,shareId,token}});
  // Keep report title, body and comment text out of persistent Teams cards.
  const body:NonNullable<IAdaptiveCard["body"]>=[{type:"TextBlock",text:"共有レポート",weight:"Bolder",wrap:true},
    {type:"TextBlock",text:"本文とコメントの閲覧、共有先の変更・コメント編集はWeb画面で行えます。送信時にも現在の参照権限を確認します。",wrap:true}];
  if(notice)body.push({type:"TextBlock",text:notice,wrap:true});
  const actions:NonNullable<IAdaptiveCard["actions"]>=[{type:"Action.OpenUrl",title:"レポート・共有設定を開く",url},action("refresh","状態を再確認")];
  if(!report.restricted&&"canComment" in report&&report.canComment) {
    const roots=(report.comments??[]).filter(c=>!c.parentId&&!c.deleted).slice(-20);
    body.push({type:"Input.ChoiceSet",id:"replyTo",label:"投稿先",value:"new",choices:[{title:"レポート全体へ新規コメント",value:"new"},...roots.map((c,i)=>({title:`コメント ${i+1}（${new Date(c.createdAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})} 日本時間）`,value:c.id}))]},
      {type:"Input.Text",id:"commentBody",label:"コメント・返信",isMultiline:true,isRequired:true,maxLength:4000,errorMessage:"コメントを入力してください。",placeholder:"4000バイト以内（日本語の目安：約1300文字）"});
    if((report.comments??[]).filter(c=>!c.parentId&&!c.deleted).length>20)body.push({type:"TextBlock",text:"返信先は最新20件です。古いコメントへの返信はWeb画面をご利用ください。",wrap:true});
    actions.push(action("post","コメントを送信"));
  } else body.push({type:"TextBlock",text:report.restricted?"現在の参照権限を確認できません。Web画面で接続状態・共有設定をご確認ください。":"閲覧のみの権限です。コメントするには所有者へ権限変更を依頼してください。",wrap:true});
  return {type:"AdaptiveCard",version:"1.4",body,actions};
}

export async function handleTeamsCanvas(activity:CanvasTeamsActivity,api:CanvasTeamsApi):Promise<TeamsCanvasReply> {
  try {
    const actor=await resolveTeamsCanvasActor(activity,api),conversation=activity.conversation!.id!;
    return await withCanvasActor(actor,async()=>{
      const data=dataObject(activity.value);
      if(isTeamsCanvasSubmission(data)) {
        const shareId=data!.shareId;
        if(typeof shareId!=="string"||!uuid.test(shareId))throw new TeamsCanvasError("共有レポートの指定を確認してください。");
        const claim=verify(data!.token,actor,conversation,shareId);
        if(data!.operation==="post") {
          if(typeof data!.commentBody!=="string"||!data!.commentBody.trim()||new TextEncoder().encode(data!.commentBody).length>4000)throw new TeamsCanvasError("コメントは空欄にせず、4000バイト以内で入力してください。");
          const parentId=data!.replyTo===undefined||data!.replyTo==="new"?undefined:data!.replyTo;
          if(parentId!==undefined&&(typeof parentId!=="string"||!uuid.test(parentId)))throw new TeamsCanvasError("返信先を確認してください。");
          await changeCanvasComment(shareId,{action:"create",revision:claim.revision,body:data!.commentBody,...(parentId?{parentId}:{})});
          try {return {card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId),"コメントを保存しました。")};}
          catch{return {text:"コメントは保存済みです。最新の状態を確認できないため、共有URLをもう一度送るか、Web画面をご確認ください。"};}
        }
        if(data!.operation!=="refresh")throw new TeamsCanvasError("カードの操作を確認してください。");
        return {card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId))};
      }
      const shareId=teamsCanvasLink(activity.text);
      if(!shareId)return {text:"AzureChatの共有レポートURLを、この個人チャットへ送ってください。"};
      return {card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId))};
    });
  }catch(error){return {text:error instanceof TeamsCanvasError||error instanceof CanvasShareError?error.message:"共有レポートを確認できません。Web画面でSalesforce本人接続と共有権限をご確認ください。"};}
}
