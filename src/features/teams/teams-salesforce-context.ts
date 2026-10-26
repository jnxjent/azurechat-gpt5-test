import "server-only";
import {createHash} from "node:crypto";
import {HistoryContainer} from "@/features/common/services/cosmos";
import {personalSalesforceForEmail,personalSalesforceUsers} from "@/features/common/services/salesforce-personal";
import type {CanvasActor} from "@/features/canvas/canvas-actor";

const type="TEAMS_SF_OPPORTUNITY_CONTEXT";
export type TeamsOpportunityContext={id:string;owner:string;token?:string;etag?:string};
function identity(actor:CanvasActor,conversation:string) {
  const bot=process.env.TEAMS_BOT_ID?.trim()||process.env.AZURE_AD_CLIENT_ID?.trim();
  if(!bot||!conversation||conversation.length>2000||!actor.salesforcePrincipal||!personalSalesforceForEmail(actor.email)||!personalSalesforceUsers().some(v=>v.principal===actor.salesforcePrincipal&&v.email===actor.email))throw Error("Unverified Teams Salesforce identity");
  const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {owner:`teams-sf-${digest([bot,actor.salesforcePrincipal,actor.email])}`,id:`teams-opportunity-${digest(conversation)}`};
}
/** Actor must come from the SDK-authenticated activity and authoritative roster. */
export async function readTeamsOpportunityContext(actor:CanvasActor,conversation:string):Promise<TeamsOpportunityContext> {
  const {id,owner}=identity(actor,conversation);
  try {
    const {resource}=await HistoryContainer().item(id,owner).read<{type:string;userId:string;token:string;expiresAt:number;_etag?:string}>();
    if(resource&&(resource.type!==type||resource.userId!==owner||typeof resource.token!=="string"||resource.token.length>7500||!Number.isSafeInteger(resource.expiresAt)))throw Error("Invalid Teams Opportunity context");
    return {id,owner,etag:resource?._etag,token:resource&&resource.expiresAt>Date.now()?resource.token||undefined:undefined};
  }catch(error){if((error as {code?:number}).code===404)return {id,owner};throw error;}
}
export async function saveTeamsOpportunityContext(actor:CanvasActor,conversation:string,previous:TeamsOpportunityContext,token:unknown) {
  const {id,owner}=identity(actor,conversation);
  if(previous.id!==id||previous.owner!==owner||token!==undefined&&(typeof token!=="string"||!token||token.length>7500))throw Error("Invalid Teams Opportunity update");
  const record={id,userId:owner,type,token:typeof token==="string"?token:"",expiresAt:Date.now()+1800000,ttl:1800};
  if(previous.etag)await HistoryContainer().item(id,owner).replace(record,{accessCondition:{type:"IfMatch",condition:previous.etag}});
  else if(token!==undefined)await HistoryContainer().items.create(record);
}
