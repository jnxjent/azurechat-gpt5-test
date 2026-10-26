import "server-only";
import {resolveSalesforceRoute,type SalesforceRoutingInput} from "@/features/common/services/salesforce-routing";
import type {CanvasActor} from "@/features/canvas/canvas-actor";

export function isTeamsOpportunityFollowup(message:string):boolean {
  const text=message.normalize("NFKC").trim();
  return /^(?:(?:同社|同じ会社|その会社|上記)の?)?(?:進行中|成約|受注|失注|すべての商談|全ての商談)(?:は|の商談|の案件|した商談|を出して|を見せて|を教えて|だけ)?[。?？!！]*$/.test(text)||
    /^\d{1,3}(?:番(?:目)?)?(?:\s*(?:、|,|と|及び|および|・)\s*\d{1,3}(?:番(?:目)?)?)*(?:だけ|で|を)?[。?？!！]*$/.test(text)||
    /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(text)||
    /^(?:全(?:アカウント|取引先|体)|上記全て|すべてのアカウント).*(?:戻|失注|成約|進行中|対象|表示|調べ)/.test(text)||
    /^.{1,80}(?:営業室|営業部|営業所|支店|本部)(?:だけ|のみ|に絞って)[。?？]*$/.test(text);
}
export async function resolveTeamsSalesforceRoute(input:SalesforceRoutingInput&{actor?:CanvasActor;conversationId:string;allowInference?:boolean}) {
  const route=resolveSalesforceRoute({...input,inferFromContent:input.allowInference!==false});
  if(route.route!=="normal"||input.allowInference===false||!input.isSalesforceAllowed||!input.actor||process.env.SF_OPPORTUNITY_POPULATION_ENABLED!=="true"||!isTeamsOpportunityFollowup(input.message))return route;
  const {readTeamsOpportunityContext}=await import("./teams-salesforce-context");
  const context=await readTeamsOpportunityContext(input.actor,input.conversationId);
  return context.token?resolveSalesforceRoute({...input,defaultToSalesforce:true}):route;
}
