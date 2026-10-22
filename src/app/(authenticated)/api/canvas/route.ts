import { isPersonalSalesforceUser } from "@/features/common/services/salesforce-personal";
import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { CHAT_THREAD_ATTRIBUTE } from "@/features/chat-page/chat-services/models";
import { validateCanvas, CanvasDocument } from "@/features/canvas/canvas-rules";
import { canvasIdFor as idFor } from "@/features/canvas/canvas-service";
export const runtime="nodejs";
export const dynamic="force-dynamic";
interface Stored extends CanvasDocument {id:string;type:"USER_CANVAS";userId:string;ttl:number;_etag?:string;updatedAt?:string;history?:CanvasDocument[];canvasAccessSeal?:string;historyAccessSeals?:string[]}
const headers={"Cache-Control":"private, no-store"};
const restricted=()=>Response.json({error:"現在のSalesforce権限で再検証できないため、このCanvasは表示・変更できません。必要なデータを改めて取得してください。"},{status:403,headers});
async function accessible(thread:string,user:string,item?:Stored) {
  if(!await isPersonalSalesforceUser())return true;
  try {
    const access=await import("@/features/common/services/salesforce-history-access");
    return !item || await access.canReadCanvas(item,user);
  }catch{return false;}
}
async function owned(threadId:string,userId:string) {
  const {resources}=await HistoryContainer().items.query({query:"SELECT c.id FROM c WHERE c.id=@id AND c.userId=@user AND c.type=@type AND c.isDeleted=false",
    parameters:[{name:"@id",value:threadId},{name:"@user",value:userId},{name:"@type",value:CHAT_THREAD_ATTRIBUTE}]},{partitionKey:userId}).fetchAll();
  return resources.length>0;
}
async function read(threadId:string,userId:string) {
  try {
    const {resource}=await HistoryContainer().item(idFor(threadId),userId).read<Stored>();
    if(resource && (resource.type!=="USER_CANVAS" || resource.userId!==userId || resource.threadId!==threadId)) throw new Error("Invalid owner");
    return resource;
  } catch(error) {if((error as {code:number}).code===404)return undefined;throw error;}
}
function failure(error:unknown) {
  const message=error instanceof Error?error.message:"";
  const code=(error as {code?:number}).code;
  return Response.json({error:message==="User not found"?"ログインしてください。":error instanceof TypeError?message:[409,412].includes(code??0)?"別の画面で更新されています。再表示して確認してください。":"Canvasを操作できませんでした。"},
    {status:message==="User not found"?401:error instanceof TypeError?400:[409,412].includes(code??0)?409:500,headers});
}
export async function GET(request:Request) {
  try {
    const userId=await userHashedId(), params=new URL(request.url).searchParams, threadId=params.get("threadId")??"";
    if(params.get("list")==="1") {
      const {resources:threads}=await HistoryContainer().items.query({query:"SELECT c.id FROM c WHERE c.userId=@user AND c.type=@type AND c.isDeleted=false",parameters:[{name:"@user",value:userId},{name:"@type",value:CHAT_THREAD_ATTRIBUTE}]},{partitionKey:userId}).fetchAll();
      const ids=new Set(threads.map((t:{id:string})=>t.id));
      const {resources}=await HistoryContainer().items.query<Stored>({query:"SELECT * FROM c WHERE c.userId=@user AND c.type=@type",parameters:[{name:"@user",value:userId},{name:"@type",value:"USER_CANVAS"}]},{partitionKey:userId}).fetchAll();
      const personal=await isPersonalSalesforceUser();
      const access=personal?await import("@/features/common/services/salesforce-history-access"):undefined;
      // The library reveals no protected title and performs no SF requests.
      // Current permissions are checked only when the document is opened.
      const visible=resources.filter(d=>ids.has(d.threadId)).map(d=>{
        const publicTitle=!access || access.legacyOrigin(d,userId)==="non_sf" || (access.validCanvasSeal(d,userId,d.canvasAccessSeal)&&d.sourceMessageIds?.length===0);
        return {threadId:d.threadId,title:publicTitle?d.title:"権限確認が必要なCanvas",updatedAt:d.updatedAt,version:d.version};
      });
      return Response.json({items:visible.sort((a,b)=>(b.updatedAt??"").localeCompare(a.updatedAt??""))},{headers});
    }
    if(!threadId || threadId.length>200)throw new TypeError("チャットを指定してください。");
    if(!await owned(threadId,userId))return Response.json({error:"チャットが見つかりません。"},{status:404,headers});
    const item=await read(threadId,userId);
    if(!await accessible(threadId,userId,item))return restricted();
    let history=item?.history??[];
    if(await isPersonalSalesforceUser()) {
      const access=await import("@/features/common/services/salesforce-history-access");
      history=(await Promise.all(history.map(async (doc,i)=>await access.canReadCanvas({...doc,id:item?.id,canvasAccessSeal:item?.historyAccessSeals?.[i]},userId)?doc:null))).filter((doc):doc is CanvasDocument=>doc!==null);
    }
    return Response.json({item:item?validateCanvas(item):null,...(params.get("history")==="1"?{history:history.map(validateCanvas)}:{})},{headers});
  }catch(error){return failure(error);}
}
export async function PUT(request:Request) {
  try {
    const userId=await userHashedId();
    if(Number(request.headers.get("content-length"))>180000)throw new TypeError("文書が大きすぎます。");
    const text=await request.text();
    if(new TextEncoder().encode(text).length>180000)throw new TypeError("文書が大きすぎます。");
    let data;try{data=JSON.parse(text);}catch{throw new TypeError("文書が正しくありません。");}
    const input=validateCanvas(data);
    if(!await owned(input.threadId,userId))return Response.json({error:"チャットが見つかりません。"},{status:404,headers});
    const current=await read(input.threadId,userId);
    if(!await accessible(input.threadId,userId,current))return restricted();
    if(input.version!==(current?.version??0))return Response.json({error:"別の画面で更新されています。再表示して確認してください。"},{status:409,headers});
    const item:Stored={...input,id:idFor(input.threadId),type:"USER_CANVAS",userId,ttl:-1,version:input.version+1,updatedAt:new Date().toISOString(),history:current?[validateCanvas(current),...(current.history??[])].slice(0,5):[]};
    if(await isPersonalSalesforceUser()) {
      const access=await import("@/features/common/services/salesforce-history-access");
      try { item.sourceMessageIds=await access.canvasSources(input,userId,current); } catch { return restricted(); }
      delete item.sourceContent;
      item.canvasAccessSeal=access.sealCanvas(item,userId);
      item.historyAccessSeals=current?[current.canvasAccessSeal??"",...(current.historyAccessSeals??[])].slice(0,5):[];
    }
    if(current){
      if(!current._etag)throw new Error("Missing etag");
      await HistoryContainer().item(item.id,userId).replace(item,{accessCondition:{type:"IfMatch",condition:current._etag}});
    }else await HistoryContainer().items.create(item);
    return Response.json({item:validateCanvas(item)},{headers});
  }catch(error){return failure(error);}
}
