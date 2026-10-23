import "server-only";
import { createHash,createHmac,randomUUID,timingSafeEqual } from "node:crypto";
import type { IAdaptiveCard } from "@microsoft/teams.cards";
import { withCanvasActor,type CanvasActor } from "@/features/canvas/canvas-actor";
import { createSharedCanvas,getSharedCanvas,changeSharedCanvas,searchCanvasSharePeople,changeCanvasComment,CanvasShareError } from "@/features/canvas/shared-canvas-service";
import {CanvasAccountSelectionError,CanvasSourceError} from "@/features/canvas/canvas-source";
import {queryTeamsSalesforce} from "./teams-salesforce-service";
import type {SalesforceAccount} from "@/features/common/services/salesforce-account-selection";
import {rememberTeamsCanvasConversation,notifyTeamsCanvasShare} from "./teams-canvas-notifications";
import { isSalesforceAllowedEmail } from "@/features/common/services/salesforce-access";
import {canvasDialogUrl} from "./teams-canvas-dialog";

export type CanvasTeamsActivity={channelId?:unknown;text?:unknown;value?:unknown;conversation?:{id?:string;conversationType?:unknown;tenantId?:unknown};from?:{id?:string;aadObjectId?:unknown};channelData?:{tenant?:{id?:unknown}}};
export type CanvasTeamsApi={conversations:{members:(id:string)=>{getById:(id:string)=>Promise<{id?:string;aadObjectId?:string;tenantId?:string;email?:string;userPrincipalName?:string}>}}};
export type TeamsCanvasReply={text?:string;card?:IAdaptiveCard};
/** Fast invoke response: SF retrieval runs after the HTML dialog is open. */
export async function openTeamsCanvasDialog(activity:CanvasTeamsActivity,api:CanvasTeamsApi) {
  const actor=await resolveTeamsCanvasActor(activity,api),data=teamsCanvasSubmission(activity.value);
  if(!data||typeof data.shareId!=="string"||!uuid.test(data.shareId))throw new TeamsCanvasError("Canvasのカードから操作してください。");
  const claim=verify(data.token,actor,activity.conversation!.id!,data.shareId);
  if(data.operation==="chooseAccount") {
    if(!claim.canvas||!claim.query||typeof data.accountId!=="string"||!claim.accounts?.includes(data.accountId))throw new TeamsCanvasError("取引先を選択してください。");
    const hex=createHmac("sha256",key()).update("teams-canvas-create-v1:"+JSON.stringify([actor.salesforcePrincipal,claim.nonce,data.accountId])).digest("hex");
    const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
    return canvasDialogUrl(actor,{id,query:claim.query,accountId:data.accountId});
  }
  if(data.operation!=="dialog")throw new TeamsCanvasError("操作を確認してください。");
  return canvasDialogUrl(actor,{id:data.shareId});
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const feature="ac.canvas";
const permissionField=(email:string)=>"role_"+createHash("sha256").update(email).digest("hex").slice(0,16);
class TeamsCanvasError extends Error {}
function baseUrl() {
  const url=new URL(process.env.NEXTAUTH_URL??"");
  if(url.protocol!=="https:"||url.username||url.password)throw new TeamsCanvasError("共有レポートの接続先設定を確認してください。");
  return url;
}
function dataObject(value:unknown):Record<string,unknown>|null {return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;}
/** Normalize the documented Teams Submit and Execute envelopes, never identity fields. */
export function teamsCanvasSubmission(value:unknown):Record<string,unknown>|null {
  if(typeof value==="string"&&value.length<=160000){try{value=JSON.parse(value);}catch{return null;}}
  const root=dataObject(value),action=dataObject(root?.action);
  for(const candidate of [root,dataObject(action?.data),dataObject(root?.data)])if(candidate?.feature===feature)return candidate;
  return null;
}
export function isTeamsCanvasSubmission(value:unknown) {return teamsCanvasSubmission(value)!==null;}
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
  const actor={salesforcePrincipal:principal,email};
  await rememberTeamsCanvasConversation(actor,activity.conversation.id);
  return actor;
}

type CardClaim={v:1;principal:string;conversation:string;shareId:string;revision:number;expires:number;nonce:string;query?:string;accounts?:string[];canvas?:boolean;people?:string[];documentVersion?:number};
function key() {const value=process.env.SF_PERSONAL_SIGNING_KEY??"";if(value.length<32)throw new TeamsCanvasError("共有カードの署名設定を確認してください。");return value;}
function sign(raw:string) {return createHmac("sha256",key()).update("teams-canvas-card-v1:"+raw).digest("hex");}
function issue(actor:CanvasActor,conversation:string,shareId:string,revision:number,selection?:Pick<CardClaim,"query"|"accounts"|"canvas"|"people"|"documentVersion">) {
  const claim:CardClaim={v:1,principal:actor.salesforcePrincipal!,conversation,shareId,revision,expires:Math.floor(Date.now()/1000)+1800,nonce:randomUUID(),...selection};
  const raw=Buffer.from(JSON.stringify(claim)).toString("base64url");return raw+"."+sign(raw);
}
function verify(value:unknown,actor:CanvasActor,conversation:string,shareId:string):CardClaim {
  try {
    if(typeof value!=="string"||value.length>40000)throw Error();
    const [raw,seal,...rest]=value.split(".");if(rest.length||!seal||!/^[a-f0-9]{64}$/.test(seal)||!timingSafeEqual(Buffer.from(seal,"hex"),Buffer.from(sign(raw),"hex")))throw Error();
    const claim=JSON.parse(Buffer.from(raw,"base64url").toString("utf8")) as CardClaim;
    const now=Math.floor(Date.now()/1000);
    if(claim.v!==1||claim.principal!==actor.salesforcePrincipal||claim.conversation!==conversation||claim.shareId!==shareId||!Number.isSafeInteger(claim.revision)||claim.revision<1||!uuid.test(claim.nonce)||!Number.isSafeInteger(claim.expires)||claim.expires<now||claim.expires>now+1860)throw Error();
    if(claim.query!==undefined&&(typeof claim.query!=="string"||!claim.query.trim()||claim.query.length>1000||!Array.isArray(claim.accounts)||!claim.accounts.length||claim.accounts.length>50||claim.accounts.some(id=>!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id))))throw Error();
    if(claim.people!==undefined&&(!Array.isArray(claim.people)||claim.people.length>70||claim.people.some(email=>typeof email!=="string"||email.length>320||!email.includes("@"))))throw Error();
    if(claim.documentVersion!==undefined&&(!Number.isSafeInteger(claim.documentVersion)||claim.documentVersion<0))throw Error();
    return claim;
  }catch{throw new TeamsCanvasError("このカードは期限切れか、別の利用者・会話のものです。共有URLをもう一度送ってください。");}
}
type CanvasReport=Awaited<ReturnType<typeof getSharedCanvas>>;
const creations=new Map<string,Promise<TeamsCanvasReply>>();
async function createCard(actor:CanvasActor,conversation:string,query:string,accountId?:string):Promise<TeamsCanvasReply> {
  try {
    const created=await createSharedCanvas(query,{accountId});
    return {text:`本人のSalesforce参照権限でCanvasを作成しました。Teams内の画面から確認・編集・共有できます。\n${new URL(`/canvas/shared/${created.id}`,baseUrl()).href}`,card:buildCard(actor,conversation,created.id,await getSharedCanvas(created.id))};
  }catch(error) {
    if(!(error instanceof CanvasAccountSelectionError))throw error;
    return {card:teamsAccountSelectionCard(actor,conversation,error.query,error.candidates,true)};
  }
}
export function teamsAccountSelectionCard(actor:CanvasActor,conversation:string,query:string,candidates:SalesforceAccount[],canvas=false):IAdaptiveCard {
  if(query.length>1000||!candidates.length||candidates.length>50)throw new TeamsCanvasError("検索条件と候補を確認してください。");
  const shareId=randomUUID(),token=issue(actor,conversation,shareId,1,{query,accounts:candidates.map(v=>v.id),canvas});
  return {type:"AdaptiveCard",version:"1.4",body:[{type:"TextBlock",text:"Salesforceの取引先を選択してください。",weight:"Bolder",wrap:true},{type:"TextBlock",text:"選択した取引先だけを、元の依頼の期間・集計条件で取得します。",wrap:true},{type:"Input.ChoiceSet",id:"accountId",label:"対象の取引先",isRequired:true,errorMessage:"取引先を選んでください。",choices:candidates.map(v=>({title:`${v.name} ／ ${v.billing_city||"所在地未登録"} ／ ${v.id}`,value:v.id}))}],actions:[{type:"Action.Submit",title:canvas?"この取引先でCanvasを作成":"この取引先を検索",data:{feature,operation:"chooseAccount",shareId,token,...(canvas?{msteams:{type:"task/fetch"}}:{})}}]};
}
export async function createTeamsPersonalCanvas(activity:CanvasTeamsActivity&{id?:string},api:CanvasTeamsApi,query:string):Promise<TeamsCanvasReply> {
  try {
    const actor=await resolveTeamsCanvasActor(activity,api),conversation=activity.conversation!.id!;
    const key=JSON.stringify([actor.salesforcePrincipal,conversation,activity.id,query]);
    if(activity.id&&creations.has(key))return await creations.get(key)!;
    const request=withCanvasActor(actor,()=>createCard(actor,conversation,query));
    if(activity.id){creations.set(key,request);if(creations.size>200)creations.delete(creations.keys().next().value!);}
    try{return await request;}catch(error){creations.delete(key);throw error;}
  }catch(error){return {text:error instanceof TeamsCanvasError||error instanceof CanvasShareError||error instanceof CanvasSourceError?error.message:"Canvasを作成できませんでした。本人接続と検索条件をご確認ください。"};}
}
function buildCard(actor:CanvasActor,conversation:string,shareId:string,report:CanvasReport,notice?:string,mode:"view"|"edit"|"share"|"comments"="view",people:Array<{email:string;name:string;department?:string}>=[],draft:Record<string,unknown>={}):IAdaptiveCard {
  const token=issue(actor,conversation,shareId,report.revision,{documentVersion:"document" in report?report.document?.version:undefined,...(mode==="share"?{people:Array.from(new Set([...(report.readers??[]),...people.map(v=>v.email)]))}:{})}),url=new URL(`/canvas/shared/${shareId}`,baseUrl()).href;
  const finish=(card:IAdaptiveCard):IAdaptiveCard=>new TextEncoder().encode(JSON.stringify(card)).length<=24000?card:{type:"AdaptiveCard",version:"1.4",body:[{type:"TextBlock",text:notice??"内容が長いため、この操作はWeb画面で続けてください。",wrap:true}],actions:[{type:"Action.OpenUrl",title:"同じレポートを開く",url}]};
  // Conversation Submit follows the existing bot message path, where SF checks can finish before replying.
  const action=(operation:string,title:string,inputs=false):NonNullable<IAdaptiveCard["actions"]>[number]=>({type:"Action.Submit",title,associatedInputs:inputs?"auto":"none",data:{feature,operation,shareId,token}});
  // Keep report title, body and comment text out of persistent Teams cards.
  const body:NonNullable<IAdaptiveCard["body"]>=[{type:"TextBlock",text:"共有レポート",weight:"Bolder",wrap:true},
    {type:"TextBlock",text:"コメントは送信すると保存されます。投稿完了はBOTからお知らせします。本文とコメントはWeb画面で確認できます。",wrap:true}];
  if(notice)body.push({type:"TextBlock",text:notice,wrap:true});
  const commentsLink=mode==="comments"||notice?.startsWith("コメント");
  const actions:NonNullable<IAdaptiveCard["actions"]>=[{type:"Action.Submit",title:"Teams内でレポートを開く",associatedInputs:"none",data:{feature,operation:"dialog",shareId,token,msteams:{type:"task/fetch"}}},{type:"Action.OpenUrl",title:commentsLink?"コメントを確認":"ブラウザーで開く",url:commentsLink?url+"#comments":url},action("refresh","状態を再確認")];
  if(mode==="edit"&&!report.restricted&&"canEdit" in report&&report.canEdit&&"document" in report&&report.document) {
    const doc=report.document;
    body.push({type:"TextBlock",text:"共有レポートを編集します。元のチャットとSalesforceのレコードは変更しません。",wrap:true},
      {type:"Input.Text",id:"title",label:"タイトル",value:doc.title,maxLength:120,isRequired:true},
      {type:"Input.Text",id:"content",label:"本文",value:doc.content,isMultiline:true,maxLength:60000},
      {type:"Input.Text",id:"unit",label:"単位",value:doc.unit,maxLength:40},
      {type:"Input.Text",id:"period",label:"対象期間",value:doc.period,maxLength:120},
      {type:"Input.ChoiceSet",id:"chartType",label:"グラフ",value:doc.chartType,choices:[{title:"棒グラフ",value:"bar"},{title:"折れ線グラフ",value:"line"}]},
      {type:"Input.Number",id:"tableIndex",label:"対象の表（1から）",value:doc.tableIndex+1,min:1,max:10},
      {type:"Input.Number",id:"valueColumn",label:"数値の列（2列目以降）",value:doc.valueColumn+1,min:2,max:101});
    actions.push(action("edit","変更を保存",true));
    return finish({type:"AdaptiveCard",version:"1.4",body,actions});
  }
  if(mode==="share"&&report.owner&&!report.restricted) {
    const selected=report.readers??[],available=new Map(people.map(v=>[v.email,v]));
    for(const email of selected)if(!available.has(email))available.set(email,{email,name:email});
    body.push({type:"Input.Text",id:"peopleQuery",label:"共有先を検索（氏名・SF部署名・メール）",maxLength:120,value:typeof draft.peopleQuery==="string"?draft.peopleQuery:""});
    actions.push(action("people","候補を検索",true));
    if(available.size)body.push({type:"Input.ChoiceSet",id:"readers",label:"共有先を選択",isMultiSelect:true,value:selected.join(","),choices:Array.from(available.values()).map(v=>({title:`${v.name} ／ ${v.department||"部署未登録"} ／ ${v.email}`,value:v.email}))},
      {type:"Input.ChoiceSet",id:"permission",label:"権限の一括設定",value:["keep","view","comment","edit"].includes(String(draft.permission))?String(draft.permission):"keep",choices:[{title:"個別設定を使う（新規は閲覧可）",value:"keep"},{title:"全員を閲覧可",value:"view"},{title:"全員をコメント可",value:"comment"},{title:"全員を編集可",value:"edit"}]},
      {type:"Input.Text",id:"sharingMessage",label:"共有メッセージ（Teams通知で送信・任意・4000バイト以内）",value:typeof draft.sharingMessage==="string"?draft.sharingMessage:"",isMultiline:true,maxLength:4000},
      {type:"Input.Toggle",id:"notifyTeams",title:"Teamsでリンクと共有メッセージを送る（オフなら送信しません）",value:draft.notifyTeams==="false"?"false":"true"},
      {type:"Input.Toggle",id:"sharingEnabled",title:"選択した相手への共有を有効にする",value:draft.sharingEnabled==="true"||draft.sharingEnabled!=="false"&&report.enabled?"true":"false"});
    for(const email of selected) {
      const field=permissionField(email),person=available.get(email);
      body.push({type:"Input.ChoiceSet",id:field,label:`${person?.name??email}さんの個別権限`,value:["view","comment","edit"].includes(String(draft[field]))?String(draft[field]):report.permissions?.[email]??"view",choices:[{title:"閲覧可",value:"view"},{title:"コメント可",value:"comment"},{title:"編集可",value:"edit"}]});
    }
    if(available.size)actions.push(action("people","選択した相手の個別権限を設定",true));
    if(available.size)actions.push(action("access","共有する",true));
    body.push({type:"ActionSet",actions:[action("revoke","共有を解除")]});
    return finish({type:"AdaptiveCard",version:"1.4",body,actions});
  }
  if(mode==="comments"&&!report.restricted&&"comments" in report) {
    const comments=report.comments??[];let bytes=0;const visible=[];
    for(const comment of comments.slice(-20).reverse()) {
      const text=Array.from(comment.deleted?"このコメントは削除されました。":comment.body).slice(0,400).join("");
      const line=`${comment.parentId?"返信 ／ ":""}${comment.authorName} ／ ${comment.department||"部署未登録"}\n${new Date(comment.createdAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}\n${text}${Array.from(comment.body).length>400?"…（全文はWeb）":""}`;
      bytes+=new TextEncoder().encode(line).length;if(bytes>10000)break;
      visible.unshift({type:"TextBlock" as const,text:line.replace(/[\\`*_[\]<>]/g,"\\$&"),wrap:true,separator:true});
    }
    body.push({type:"TextBlock",text:`コメント ${comments.filter(c=>!c.deleted).length}件（最新の表示範囲）`,weight:"Bolder",wrap:true},...visible);
    if(!comments.length)body.push({type:"TextBlock",text:"コメントはまだありません。",wrap:true});
  }
  if(!report.restricted)actions.push(action("comments","コメントを読む"));
  if(!report.restricted&&"canEdit" in report&&report.canEdit)actions.push(action("editForm","レポートを編集"));
  if(report.owner&&!report.restricted)actions.push(action("shareForm","共有"));
  if(!report.restricted&&"canComment" in report&&report.canComment) {
    const roots=(report.comments??[]).filter(c=>!c.parentId&&!c.deleted).slice(-20);
    body.push({type:"Input.ChoiceSet",id:"replyTo",label:"投稿先",value:"new",choices:[{title:"レポート全体へ新規コメント",value:"new"},...roots.map((c,i)=>({title:`コメント ${i+1}（${new Date(c.createdAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})} 日本時間）`,value:c.id}))]},
      {type:"Input.Text",id:"commentBody",label:"コメント・返信",isMultiline:true,isRequired:true,maxLength:4000,errorMessage:"コメントを入力してください。",placeholder:"4000バイト以内（日本語の目安：約1300文字）"});
    if((report.comments??[]).filter(c=>!c.parentId&&!c.deleted).length>20)body.push({type:"TextBlock",text:"返信先は最新20件です。古いコメントへの返信はWeb画面をご利用ください。",wrap:true});
    body.push({type:"ActionSet",actions:[action("post","コメントを送信",true)]});
  } else body.push({type:"TextBlock",text:report.restricted?"現在の参照権限を確認できません。Web画面で接続状態・共有設定をご確認ください。":"閲覧のみの権限です。コメントするには所有者へ権限変更を依頼してください。",wrap:true});
  return finish({type:"AdaptiveCard",version:"1.4",body,actions});
}

export async function handleTeamsCanvas(activity:CanvasTeamsActivity,api:CanvasTeamsApi):Promise<TeamsCanvasReply> {
  try {
    const actor=await resolveTeamsCanvasActor(activity,api),conversation=activity.conversation!.id!;
    return await withCanvasActor(actor,async()=>{
      const data=teamsCanvasSubmission(activity.value);
      if(isTeamsCanvasSubmission(data)) {
        const shareId=data!.shareId;
        if(typeof shareId!=="string"||!uuid.test(shareId))throw new TeamsCanvasError("共有レポートの指定を確認してください。");
        // Invitations contain only a report ID. Opening is a read operation,
        // authenticated just like pasting its URL; writes still require tokens.
        if(data!.operation==="open")return {card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId))};
        const claim=verify(data!.token,actor,conversation,shareId);
        if(data!.operation==="comments")return {card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId),undefined,"comments")};
        if(data!.operation==="chooseAccount") {
          if(!claim.query||typeof data!.accountId!=="string"||!claim.accounts?.includes(data!.accountId))throw new TeamsCanvasError("表示された取引先から選択してください。");
          const key=`selection:${claim.nonce}:${data!.accountId}`;
          if(claim.canvas===false)return {text:await queryTeamsSalesforce({message:claim.query,userEmail:actor.email,conversationId:conversation,activityId:claim.nonce,actor,accountId:data!.accountId})};
          if(creations.has(key))return await creations.get(key)!;
          const request=createCard(actor,conversation,claim.query,data!.accountId);creations.set(key,request);if(creations.size>200)creations.delete(creations.keys().next().value!);
          try{return await request;}catch(error){creations.delete(key);throw error;}
        }
        if(["editForm","shareForm","people"].includes(String(data!.operation))) {
          let report=await getSharedCanvas(shareId);
          const mode=data!.operation==="editForm"?"edit":"share";
          if(mode==="edit"&&(!("canEdit" in report)||!report.canEdit)||mode==="share"&&!report.owner)throw new TeamsCanvasError("この操作の権限がありません。");
          let selected=report.readers??[];
          if(mode==="share"&&data!.operation==="people") {
            selected=typeof data!.readers==="string"?data!.readers.split(",").map(v=>v.trim()).filter(Boolean):[];
            if(selected.length>50||selected.some(email=>!claim.people?.includes(email)))throw new TeamsCanvasError("前の候補から共有先を選び直してください。");
            if(typeof data!.sharingMessage==="string"&&new TextEncoder().encode(data!.sharingMessage).length>4000)throw new TeamsCanvasError("共有メッセージは4000バイト以内で入力してください。");
            report={...report,readers:selected};
          }
          const people=mode==="share"?(await searchCanvasSharePeople(typeof data!.peopleQuery==="string"?data!.peopleQuery:"",selected)).items:[];
          return {card:buildCard(actor,conversation,shareId,report,undefined,mode,people,data!)};
        }
        if(data!.operation==="edit") {
          await changeSharedCanvas(shareId,{action:"edit",revision:claim.revision,document:{title:data!.title,content:data!.content,unit:data!.unit??"",period:data!.period??"",chartType:data!.chartType,tableIndex:Number(data!.tableIndex)-1,valueColumn:Number(data!.valueColumn)-1}});
          return {text:"レポートの変更を保存しました。同じ共有URLへ反映しました。",card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId))};
        }
        if(data!.operation==="access"||data!.operation==="revoke") {
          const current=await getSharedCanvas(shareId);
          if(!current.owner)throw new TeamsCanvasError("共有先の変更は所有者だけが行えます。");
          const readers=typeof data!.readers==="string"?data!.readers.split(",").map(v=>v.trim()).filter(Boolean):[];
          const role=data!.permission??"keep";
          if(!["keep","view","comment","edit"].includes(String(role)))throw new TeamsCanvasError("共有権限を確認してください。");
          const enabled=data!.operation!=="revoke"&&data!.sharingEnabled==="true";
          await changeSharedCanvas(shareId,{action:"access",revision:claim.revision,enabled,readers:enabled?readers:[],permissions:enabled?Object.fromEntries(readers.map(email=>[email,role==="keep"?data![permissionField(email)]??current.permissions?.[email]??"view":role])):{},message:enabled&&data!.notifyTeams==="true"?data!.sharingMessage:undefined});
          const notified=enabled&&data!.notifyTeams==="true"?await notifyTeamsCanvasShare(shareId,data!.sharingMessage):undefined;
          const notification=notified?` Teams通知：送信${notified.sent}件・BOT未登録等${notified.unavailable}件・失敗${notified.failed}件。${notified.error??""}`:"";
          return {text:(enabled?"共有しました。共有メッセージは通知を有効にした場合のみTeamsで送信します。レポートのコメント欄には投稿されません。":"共有を解除しました。")+notification,card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId))};
        }
        if(data!.operation==="post") {
          if(typeof data!.commentBody!=="string"||!data!.commentBody.trim()||new TextEncoder().encode(data!.commentBody).length>4000)throw new TeamsCanvasError("コメントは空欄にせず、4000バイト以内で入力してください。");
          const parentId=data!.replyTo===undefined||data!.replyTo==="new"?undefined:data!.replyTo;
          if(parentId!==undefined&&(typeof parentId!=="string"||!uuid.test(parentId)))throw new TeamsCanvasError("返信先を確認してください。");
          const input={action:"create",requestId:claim.nonce,revision:claim.revision,body:data!.commentBody,...(parentId?{parentId}:{})};
          let saved:Awaited<ReturnType<typeof changeCanvasComment>>;
          try {saved=await changeCanvasComment(shareId,input);}
          catch(error) {
            if(!(error instanceof CanvasShareError)||error.status!==409||claim.documentVersion===undefined)throw error;
            const latest=await getSharedCanvas(shareId);
            if(latest.restricted||!("canComment" in latest)||!latest.canComment||!("document" in latest)||latest.document?.version!==claim.documentVersion)throw error;
            saved=await changeCanvasComment(shareId,{...input,revision:latest.revision});
          }
          console.info("[teams-canvas] comment committed",{shareId,revision:saved.revision,duplicate:saved.duplicate});
          try {return {text:"コメントを投稿しました。共有レポートの「コメントを確認」から確認できます。",card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId),"コメントを投稿しました。")};}
          catch{return {text:"コメントは保存済みです。最新の状態を確認できないため、共有URLをもう一度送るか、Web画面をご確認ください。"};}
        }
        if(data!.operation!=="refresh")throw new TeamsCanvasError("カードの操作を確認してください。");
        return {card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId))};
      }
      const shareId=teamsCanvasLink(activity.text);
      if(!shareId)return {text:"AzureChatの共有レポートURLを、この個人チャットへ送ってください。"};
      return {card:buildCard(actor,conversation,shareId,await getSharedCanvas(shareId))};
    });
  }catch(error){return {text:error instanceof TeamsCanvasError||error instanceof CanvasShareError||error instanceof CanvasSourceError?error.message:"共有レポートを確認できません。Web画面でSalesforce本人接続と共有権限をご確認ください。"};}
}
