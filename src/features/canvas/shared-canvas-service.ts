import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getCanvasActor } from "./canvas-actor";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { isSalesforceAllowedEmail } from "@/features/common/services/salesforce-access";
import { retrieveCanvasSource, revalidateCanvasSource, type Source } from "./canvas-source";
import { validateCanvas, type CanvasDocument } from "./canvas-rules";

export type CanvasShareUser = { principal: string; email: string; name?:string; department?:string; permission?:"view"|"comment"|"edit" };
export type CanvasComment = {id:string;parentId?:string;author:CanvasShareUser;body:string;createdAt:string;updatedAt:string;reportVersion:number;deleted?:boolean};
type SharedCanvas = { id: string; userId: "CANVAS_SHARE"; type: "SHARED_CANVAS"; ttl: -1; owner: CanvasShareUser; readers: CanvasShareUser[]; enabled: boolean; revision: number; updatedAt: string; document: CanvasDocument; source: Source; comments?:CanvasComment[]; seal: string; _etag?: string };
const partition = "CANVAS_SHARE";
export class CanvasShareError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function participants(): Promise<CanvasShareUser[]> {
  if(process.env.CANVAS_SHARE_DIRECTORY_PROVIDER==="salesforce") {
    const {salesforceShareDirectory}=await import("./share-directory");
    return salesforceShareDirectory();
  }
  const values = JSON.parse(process.env.CANVAS_SHARE_USERS_JSON ?? "[]");
  if (!Array.isArray(values) || values.some(v => !v || typeof v.principal !== "string" || !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(v.principal) || typeof v.email !== "string" || !v.email.includes("@"))) throw new CanvasShareError(503, "共有対象者の設定を確認してください。");
  const users = values.map(v => ({ principal: v.principal.toLowerCase(), email: v.email.trim().toLowerCase(), ...(typeof v.name==="string"&&v.name.trim()?{name:v.name.trim().slice(0,120)}:{}),...(typeof v.department==="string"?{department:v.department.trim().slice(0,120)}:{}) }));
  if (new Set(users.map(v => v.principal)).size !== users.length || new Set(users.map(v => v.email)).size !== users.length) throw new CanvasShareError(503, "共有対象者の登録が重複しています。");
  return users;
}
export async function currentCanvasShareUser(): Promise<CanvasShareUser> {
  const user = await getCanvasActor();
  if (!isSalesforceAllowedEmail(user.email) || !user.salesforcePrincipal) throw new CanvasShareError(403, "Microsoftアカウントでログインし直してください。");
  const found = (await participants()).find(v => v.principal === user.salesforcePrincipal?.toLowerCase() && v.email === user.email.trim().toLowerCase());
  if (!found) throw new CanvasShareError(403, "Canvas共有の利用は許可されていません。");
  return found;
}
async function currentShareIdentity():Promise<CanvasShareUser> {
  const user=await getCanvasActor();
  if(!isSalesforceAllowedEmail(user.email)||!user.salesforcePrincipal||!/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(user.salesforcePrincipal))throw new CanvasShareError(403,"共有操作は許可されていません。");
  return {principal:user.salesforcePrincipal.toLowerCase(),email:user.email.trim().toLowerCase()};
}
function sameUser(a: CanvasShareUser, b: CanvasShareUser) { return a.principal === b.principal && a.email === b.email; }
async function availableReaders(user:CanvasShareUser) {
  return (await participants()).filter(v=>v.principal.split(":")[0]===user.principal.split(":")[0] && !sameUser(v,user) && isSalesforceAllowedEmail(v.email));
}
async function resolveReaders(user:CanvasShareUser, input:unknown, permissions:unknown, previous:CanvasShareUser[]=[]):Promise<CanvasShareUser[]> {
  if(!Array.isArray(input)||input.length>50||input.some(v=>typeof v!=="string"))throw new CanvasShareError(400,"共有先を確認してください。");
  const available=await availableReaders(user);
  if(permissions!==undefined && (!permissions||typeof permissions!=="object"||Array.isArray(permissions)||Object.entries(permissions).some(([email,role])=>!(input as string[]).includes(email)||!["view","comment","edit"].includes(String(role)))))throw new CanvasShareError(400,"共有権限を確認してください。");
  return Array.from(new Set((input as string[]).map(v=>v.trim().toLowerCase()).filter(Boolean))).map(email=>{
    const found=available.find(v=>v.email===email);
    if(!found)throw new CanvasShareError(400,"共有先の候補から選び直してください。");
    const permission=(permissions as Record<string,"view"|"comment"|"edit">|undefined)?.[email]??previous.find(v=>sameUser(v,found))?.permission??"view";
    return {...found,permission};
  });
}
export async function searchCanvasSharePeople(query:string,include:string[]=[]) {
  const user=await currentCanvasShareUser();
  if(query.length>120||include.length>50||include.some(email=>typeof email!=="string"))throw new CanvasShareError(400,"検索条件を確認してください。");
  const normalize=(s:string)=>s.normalize("NFKC").toLocaleLowerCase().replace(/\s/g,"");
  const needle=normalize(query);
  const available=await availableReaders(user),matches=available.filter(v=>normalize(`${v.name??""} ${v.department??""} ${v.email}`).includes(needle)).sort((a,b)=>(a.name??a.email).localeCompare(b.name??b.email,"ja"));
  const items=Array.from(new Map([...matches.slice(0,20),...available.filter(v=>include.includes(v.email))].map(v=>[v.email,v])).values());
  return {items:items.map(v=>({email:v.email,name:v.name??v.email,...(v.department?{department:v.department}:{})})),hasMore:matches.length>20};
}
function signature(record: Omit<SharedCanvas, "seal"> | SharedCanvas) {
  const secret = process.env.SF_PERSONAL_SIGNING_KEY ?? "";
  if (secret.length < 32) throw new CanvasShareError(503, "Canvas共有の署名設定を確認してください。");
  const { id, userId, type, ttl, owner, readers, enabled, revision, updatedAt, document, source } = record;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return createHmac("sha256", secret).update("shared-canvas-v1:" + JSON.stringify(canonical({ id, userId, type, ttl, owner, readers, enabled, revision, updatedAt, document: validateCanvas(document), source,...("comments" in record?{comments:record.comments}:{}) }))).digest("hex");
}
function valid(record: SharedCanvas) {
  return /^[a-f0-9]{64}$/.test(record.seal ?? "") && timingSafeEqual(Buffer.from(record.seal, "hex"), Buffer.from(signature(record), "hex"));
}
function requireId(id: string) { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new CanvasShareError(404, "Canvasが見つからないか、共有が解除されています。"); }
async function read(id: string): Promise<SharedCanvas> {
  requireId(id);
  try {
    const { resource } = await HistoryContainer().item(`shared-canvas-${id}`, partition).read<SharedCanvas>();
    if (!resource || !resource._etag || resource.type !== "SHARED_CANVAS" || resource.userId !== partition || resource.id !== `shared-canvas-${id}` || !valid(resource)) throw new CanvasShareError(404, "Canvasが見つからないか、共有が解除されています。");
    return resource;
  } catch (e) { if ((e as { code?: number }).code === 404) throw new CanvasShareError(404, "Canvasが見つからないか、共有が解除されています。"); throw e; }
}
function authorized(record: SharedCanvas, user: CanvasShareUser) {
  const owner = sameUser(record.owner, user);
  if (!owner && (!record.enabled || !record.readers.some(v => sameUser(v, user)))) throw new CanvasShareError(404, "Canvasが見つからないか、共有が解除されています。");
  return owner;
}
function management(record: SharedCanvas, owner: boolean) { return { revision: record.revision, updatedAt: record.updatedAt, owner, ...(owner ? { readers: record.readers.map(v => v.email), permissions:Object.fromEntries(record.readers.map(v=>[v.email,v.permission??"view"])), enabled: record.enabled, savedCanvas:Boolean(record.source.savedCanvas) } : {}) }; }

function savedShareId(user:CanvasShareUser,threadId:string) {
  if(!threadId || threadId.length>200)throw new CanvasShareError(400,"Canvasを指定してください。");
  const secret=process.env.SF_PERSONAL_SIGNING_KEY??"";
  if(secret.length<32)throw new CanvasShareError(503,"共有設定を確認してください。");
  const hex=createHmac("sha256",secret).update("saved-canvas-share-v1:"+JSON.stringify([user.principal,user.email,threadId])).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
async function savedShare(user:CanvasShareUser,threadId:string) {
  const id=savedShareId(user,threadId);
  try { const record=await read(id); if(!sameUser(record.owner,user)||record.source.savedCanvas?.threadId!==threadId)throw new CanvasShareError(403,"共有設定を確認できません。"); return {id,record}; }
  catch(error) { if(error instanceof CanvasShareError && error.status===404)return {id,record:undefined}; throw error; }
}
export async function getSavedCanvasSharing(threadId:string) {
  const user=await currentCanvasShareUser(), {id,record}=await savedShare(user,threadId);
  return record?{id,...management(record,true)}:{id:null,revision:null,readers:[],enabled:false};
}
export async function publishSavedCanvas(input:{threadId?:unknown;version?:unknown;revision?:unknown;readers?:unknown;permissions?:unknown;enabled?:unknown;message?:unknown}) {
  if(typeof input.threadId!=="string" || !Number.isSafeInteger(input.version) || Number(input.version)<1 || typeof input.enabled!=="boolean")throw new CanvasShareError(400,"Canvasを保存してから共有してください。");
  const user=input.enabled?await currentCanvasShareUser():await currentShareIdentity(), {id,record}=await savedShare(user,input.threadId);
  if(!input.enabled&&!record)throw new CanvasShareError(404,"解除する共有がありません。");
  if((record?.revision??null)!==input.revision)throw new CanvasShareError(409,"共有設定が変更されています。共有画面を開き直してください。");
  const readers=input.enabled?await resolveReaders(user,input.readers,input.permissions,record?.readers):[];
  if(input.enabled&&!readers.length)throw new CanvasShareError(400,"共有先を選択してください。");
  const {savedCanvasSource}=await import("./saved-canvas-source");
  const snapshot=record&&!input.enabled?{document:record.document,source:record.source}:await savedCanvasSource(input.threadId,Number(input.version));
  if(input.enabled&&!await revalidateCanvasSource(snapshot.source,user))throw new CanvasShareError(403,"現在のSalesforce権限でこのCanvasを共有できません。");
  const next:SharedCanvas={id:`shared-canvas-${id}`,userId:partition,type:"SHARED_CANVAS",ttl:-1,owner:user,readers,enabled:input.enabled,revision:(record?.revision??0)+1,updatedAt:new Date().toISOString(),...snapshot,...(record?.comments?{comments:record.comments}:{}),seal:""};
  if(record&&input.enabled)next.document={...next.document,version:Math.max(next.document.version,record.document.version+1)};
  validateSharingMessage(next,input.message);
  next.seal=signature(next);
  try {
    if(record)await HistoryContainer().item(record.id,partition).replace(next,{accessCondition:{type:"IfMatch",condition:record._etag!}});
    else await HistoryContainer().items.create(next);
  } catch(error) { if([409,412].includes((error as {code:number}).code))throw new CanvasShareError(409,"共有設定が変更されています。共有画面を開き直してください。"); throw error; }
  return {id,...management(next,true)};
}
export async function createSharedCanvas(query: string,options:{accountId?:string;id?:string}={}) {
  const user = await currentCanvasShareUser(), id = options.id??randomUUID();
  requireId(id);
  const snapshot = await retrieveCanvasSource(user, { provider: "salesforce", query: query.trim(),accountId:options.accountId });
  const record: SharedCanvas = { id: `shared-canvas-${id}`, userId: partition, type: "SHARED_CANVAS", ttl: -1, owner: user, readers: [], enabled: false, revision: 1, updatedAt: new Date().toISOString(), ...snapshot, seal: "" };
  record.seal = signature(record);
  await HistoryContainer().items.create(record);
  return { id, ...management(record, true) };
}
export async function getSharedCanvas(id: string) {
  let user:CanvasShareUser;
  try {user=await currentCanvasShareUser();}
  catch(error) {
    // A lost SF connection/directory must never prevent the actual owner revoking a share.
    const identity=await currentShareIdentity(),record=await read(id);
    if(!sameUser(record.owner,identity))throw error;
    return {...management(record,true),restricted:true};
  }
  const record = await read(id), owner = authorized(record, user);
  const allowed = await revalidateCanvasSource(record.source, user);
  // Re-read after remote checks so revocation/update during a check wins.
  const latest = await read(id); authorized(latest, user);
  if (latest._etag !== record._etag) throw new CanvasShareError(409, "更新されています。再読み込みしてください。");
  if (!allowed && !owner) throw new CanvasShareError(403, "現在のSalesforce権限でこのCanvasを参照できません。");
  return { ...management(record, owner), restricted: !allowed, ...(allowed ? { document: record.document,canEdit:owner||record.readers.some(v=>sameUser(v,user)&&v.permission==="edit"),canComment:owner||record.readers.some(v=>sameUser(v,user)&&["comment","edit"].includes(v.permission??"view")),comments:(record.comments??[]).map(c=>({id:c.id,parentId:c.parentId,authorName:c.author.name??c.author.email,department:c.author.department??"",body:c.deleted?"":c.body,createdAt:c.createdAt,updatedAt:c.updatedAt,reportVersion:c.reportVersion,deleted:!!c.deleted,mine:sameUser(c.author,user)})), ...(owner ? { query: record.source.query } : {}) } : {}) };
}
export async function changeSharedCanvas(id: string, input: { revision?: unknown; action?: unknown; readers?: unknown;permissions?:unknown; enabled?: unknown;document?:unknown;message?:unknown }) {
  const user = input.action==="access"&&input.enabled===false?await currentShareIdentity():await currentCanvasShareUser(), record = await read(id);
  const owner=authorized(record,user);
  if (!owner && (input.action!=="edit"||!record.readers.some(v=>sameUser(v,user)&&v.permission==="edit"))) throw new CanvasShareError(404, "Canvasが見つからないか、操作できません。");
  if (input.revision !== record.revision || !record._etag) throw new CanvasShareError(409, "別の画面で更新されています。再読み込みしてください。");
  let next = { ...record };
  if (input.action === "access") {
    if (!Array.isArray(input.readers) || input.readers.length > 50 || input.readers.some(v => typeof v !== "string") || typeof input.enabled !== "boolean") throw new CanvasShareError(400, "共有先を確認してください。");
    const readers = input.enabled?await resolveReaders(user,input.readers,input.permissions,record.readers):[];
    if (input.enabled && !await revalidateCanvasSource(record.source, user)) throw new CanvasShareError(403, "共有前に元データの参照権限を確認してください。");
    next.readers = readers as CanvasShareUser[]; next.enabled = input.enabled;
  } else if (input.action === "edit") {
    if(!await revalidateCanvasSource(record.source,user))throw new CanvasShareError(403,"現在のSalesforce権限でこのCanvasを編集できません。");
    if(!input.document||typeof input.document!=="object"||Array.isArray(input.document))throw new CanvasShareError(400,"編集内容を確認してください。");
    const fields=["title","content","unit","period","chartType","tableIndex","valueColumn","valueColumns"];
    if(Object.keys(input.document).some(key=>!fields.includes(key)))throw new CanvasShareError(400,"変更できない項目が含まれています。");
    try {next.document=validateCanvas({...record.document,...input.document,version:record.document.version+1});}
    catch {throw new CanvasShareError(400,"本文・グラフの入力内容を確認してください。");}
  } else if (input.action === "refresh") {
    if(record.source.savedCanvas) {
      const {savedCanvasSource}=await import("./saved-canvas-source");
      const snapshot=await savedCanvasSource(record.source.savedCanvas.threadId);
      if(!await revalidateCanvasSource(snapshot.source,user))throw new CanvasShareError(403,"元データの参照権限を確認できません。");
      next={...next,...snapshot};
      next.document={...next.document,version:Math.max(next.document.version,record.document.version+1)};
    } else {
      next = { ...next, ...await retrieveCanvasSource(user, { provider: record.source.provider, query: record.source.query,accountId:record.source.accountId }) };
      next.document.version = record.document.version + 1;
    }
  } else throw new CanvasShareError(400, "操作を確認してください。");
  if(input.action==="access")validateSharingMessage(next,input.message);
  next.revision++; next.updatedAt = new Date().toISOString(); delete next._etag;
  next.seal = signature(next);
  try { await HistoryContainer().item(record.id, partition).replace(next, { accessCondition: { type: "IfMatch", condition: record._etag } }); }
  catch (e) { if ([409, 412].includes((e as { code: number }).code)) throw new CanvasShareError(409, "別の画面で更新されています。再読み込みしてください。"); throw e; }
  return management(next, owner);
}

function validateSharingMessage(record:SharedCanvas,message:unknown) {
  if(message===undefined||message==="")return;
  if(!record.enabled||typeof message!=="string"||!message.trim()||new TextEncoder().encode(message).length>4000)throw new CanvasShareError(400,"共有メッセージは4000バイト以内で入力してください。");
  // Sharing messages belong to the recipient's conversation, not report comments.
}

/** Server-only notification target lookup; never accepts caller-provided addresses. */
export async function canvasNotificationTargets(id:string,expectedRevision?:number) {
  const user=expectedRevision===undefined?await currentCanvasShareUser():await currentShareIdentity(),record=await read(id);
  if(!sameUser(record.owner,user)||!record.enabled)throw new CanvasShareError(403,"共有通知の権限がありません。");
  if(expectedRevision!==undefined&&expectedRevision!==record.revision)throw new CanvasShareError(409,"共有設定が変更されています。");
  if(expectedRevision===undefined&&!await revalidateCanvasSource(record.source,user))throw new CanvasShareError(403,"共有元の参照権限を確認できません。");
  const latest=await read(id);
  if(latest._etag!==record._etag)throw new CanvasShareError(409,"共有設定が変更されています。");
  const available=expectedRevision===undefined?await availableReaders(user):record.readers;
  const readers=record.readers.filter(reader=>available.some(candidate=>sameUser(reader,candidate)));
  return {revision:record.revision,owner:user,readers,unavailable:record.readers.length-readers.length};
}

/** Comments share the report's signed document and ETag: revocation and writes race safely. */
export async function changeCanvasComment(id:string,input:{revision?:unknown;action?:unknown;id?:unknown;parentId?:unknown;body?:unknown;requestId?:unknown}) {
  const user=await currentCanvasShareUser(),record=await read(id),owner=authorized(record,user);
  // A retry after a lost response must not create a second comment. Never skip
  // current ACL/SF validation, even when the original submission was saved.
  if(input.requestId!==undefined&&(typeof input.requestId!=="string"||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId)))throw new CanvasShareError(400,"投稿の識別情報を確認してください。");
  const existing=input.action==="create"&&input.requestId?record.comments?.find(c=>c.id===input.requestId):undefined;
  if(existing) {
    if(!sameUser(existing.author,user)||existing.deleted||typeof input.body!=="string"||existing.body!==input.body.trim()||existing.parentId!==(input.parentId===undefined?undefined:record.comments?.find(c=>c.id===input.parentId)?.parentId??input.parentId))throw new CanvasShareError(409,"同じ投稿の内容が変更されています。再確認してください。");
    if(!owner&&!record.readers.some(v=>sameUser(v,user)&&["comment","edit"].includes(v.permission??"view")))throw new CanvasShareError(403,"コメントする権限がありません。");
    if(!await revalidateCanvasSource(record.source,user))throw new CanvasShareError(403,"現在のSalesforce権限でコメントできません。");
    const latest=await read(id);authorized(latest,user);
    if(latest._etag!==record._etag)throw new CanvasShareError(409,"更新されています。再確認してください。");
    return commentResult(record,existing,user,true);
  }
  if(input.revision!==record.revision)throw new CanvasShareError(409,"更新されています。再確認してから投稿してください。");
  if(!owner&&!record.readers.some(v=>sameUser(v,user)&&["comment","edit"].includes(v.permission??"view")))throw new CanvasShareError(403,"コメントする権限がありません。");
  if(!await revalidateCanvasSource(record.source,user))throw new CanvasShareError(403,"現在のSalesforce権限でコメントできません。");
  const latest=await read(id);authorized(latest,user);
  if(latest._etag!==record._etag)throw new CanvasShareError(409,"共有設定や内容が更新されています。再確認してください。");
  const comments=structuredClone(record.comments??[]),now=new Date().toISOString();
  if(!["create","edit","delete"].includes(String(input.action)))throw new CanvasShareError(400,"コメント操作を確認してください。");
  let body="";
  if(input.action!=="delete") {
    if(typeof input.body!=="string"||!input.body.trim()||new TextEncoder().encode(input.body).length>4000)throw new CanvasShareError(400,"コメントは空欄にせず、4000バイト以内で入力してください。");
    body=input.body.trim();
  }
  if(input.action==="create") {
    if(comments.length>=200)throw new CanvasShareError(400,"このレポートのコメント上限に達しました。");
    const parent=input.parentId===undefined?undefined:comments.find(c=>c.id===input.parentId);
    if(input.parentId!==undefined&&!parent)throw new CanvasShareError(400,"返信先を確認してください。");
    comments.push({id:typeof input.requestId==="string"?input.requestId:randomUUID(),...(parent?{parentId:parent.parentId??parent.id}:{}),author:{...user},body,createdAt:now,updatedAt:now,reportVersion:record.document.version});
  } else {
    const comment=comments.find(c=>c.id===input.id);
    if(!comment||!sameUser(comment.author,user))throw new CanvasShareError(403,"自分のコメントだけ変更できます。");
    if(comment.deleted)throw new CanvasShareError(409,"このコメントは削除済みです。");
    comment.body=input.action==="delete"?"":body;comment.updatedAt=now;
    if(input.action==="delete")comment.deleted=true;
  }
  const next={...record,comments,revision:record.revision+1,updatedAt:now};delete next._etag;next.seal=signature(next);
  if(new TextEncoder().encode(JSON.stringify(next)).length>1500000)throw new CanvasShareError(400,"レポートの保存容量を超えています。");
  try {await HistoryContainer().item(record.id,partition).replace(next,{accessCondition:{type:"IfMatch",condition:record._etag!}});}
  catch(error) {if([409,412].includes((error as {code:number}).code))throw new CanvasShareError(409,"更新されています。再確認してから投稿してください。");throw error;}
  return commentResult(next,input.action==="create"?comments[comments.length-1]:comments.find(c=>c.id===input.id)!,user,false);
}

function commentResult(record:SharedCanvas,comment:CanvasComment,user:CanvasShareUser,duplicate:boolean) {
  return {revision:record.revision,updatedAt:record.updatedAt,duplicate,comment:{id:comment.id,parentId:comment.parentId,authorName:comment.author.name??comment.author.email,department:comment.author.department??"",body:comment.deleted?"":comment.body,createdAt:comment.createdAt,updatedAt:comment.updatedAt,reportVersion:comment.reportVersion,deleted:!!comment.deleted,mine:sameUser(comment.author,user)}};
}
