import "server-only";
import {HistoryContainer} from "./cosmos";
import {userHashedId} from "@/features/auth-page/helpers";

type Stored={id:string;type:"SF_OPPORTUNITY_CONTEXT";userId:string;threadId:string;token:string;_etag?:string;ttl:number};
export type OpportunityContext={token?:string;etag?:string;id:string;owner:string;threadId:string};
/** Independent of display-history filtering: opaque Gateway-signed scope, never record data. */
export async function readOpportunityContext(threadId:string):Promise<OpportunityContext> {
  const owner=await userHashedId();
  const {resource:thread}=await HistoryContainer().item(threadId,owner).read<{type:string;userId:string;isDeleted:boolean}>();
  if(!thread||thread.type!=="CHAT_THREAD"||thread.userId!==owner||thread.isDeleted)throw Error("Thread not found");
  const id=`sf-opportunity-context-${threadId}`;
  try {
    const {resource}=await HistoryContainer().item(id,owner).read<Stored>();
    if(resource&&(resource.type!=="SF_OPPORTUNITY_CONTEXT"||resource.userId!==owner||resource.threadId!==threadId||typeof resource.token!=="string"||resource.token.length>7500))throw Error("Invalid Opportunity context");
    return {id,owner,threadId,token:resource?.token||undefined,etag:resource?._etag};
  }catch(error){if((error as {code?:number}).code===404)return {id,owner,threadId};throw error;}
}
export async function saveOpportunityContext(previous:OpportunityContext,token:unknown):Promise<void> {
  if(await userHashedId()!==previous.owner)throw Error("Context owner changed");
  if(token!==undefined&&(typeof token!=="string"||!token||token.length>7500))throw Error("Invalid Opportunity context");
  const record:Stored={id:previous.id,userId:previous.owner,threadId:previous.threadId,type:"SF_OPPORTUNITY_CONTEXT",token:typeof token==="string"?token:"",ttl:1800};
  if(previous.etag)await HistoryContainer().item(previous.id,previous.owner).replace(record,{accessCondition:{type:"IfMatch",condition:previous.etag}});
  else if(token!==undefined)await HistoryContainer().items.create(record);
}
