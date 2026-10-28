import "server-only";
import {createHash} from "node:crypto";
import {HistoryContainer} from "@/features/common/services/cosmos";
import type {CanvasActor} from "@/features/canvas/canvas-actor";
import {skillSubmission,handleTeamsSkill} from "./teams-skill-service";
import {verifySkillCard} from "./teams-skill-card";
import {deliverTeamsSkillReply} from "./teams-skill-delivery";
import {SKILL_SEARCH_LIMITS} from "@/features/skills/execution/skill-search-policy";

const TYPE="TEAMS_SKILL_JOB";
const active=new Map<string,Promise<void>>();
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type SkillJobRecord={id:string;userId:string;type:typeof TYPE;status:"running"|"delivering"|"succeeded"|"failed"|"delivery_uncertain";deadline:number;sentParts:number;ttl:number;_etag?:string};
const FAILURE="スキルの検索・レポート作成を完了できませんでした。取得失敗を0件とは扱っていません。依頼を送り直してください。";
const UNCERTAIN="スキルの回答の送信完了を確認できません。一部が届いている可能性があるため、同じ回答は自動再送しません。届いた内容を確認し、必要なら依頼を送り直してください。";
export type SkillReceiptBudget={deadline:number};
export function skillReceiptBudget(kind:"invoke"|"message"):SkillReceiptBudget{return {deadline:Date.now()+(kind==="invoke"?4500:9500)};}
export function skillReceiptRemaining(budget:SkillReceiptBudget,maximum:number){
  const remaining=Math.min(maximum,budget.deadline-Date.now());
  if(remaining<=0)throw Error("teams_skill_receipt_timeout");return remaining;
}
export async function sendSkillReceipt(send:(value:any)=>Promise<unknown>,receipt:string,budget:SkillReceiptBudget){
  const remaining=Math.min(1000,budget.deadline-Date.now());
  if(remaining<=0){console.warn("[teams-skill] receipt",{status:"notification_budget_exhausted"});return;}
  try{await boundedSkillTask(send(receipt),remaining);}catch{console.warn("[teams-skill] receipt",{status:"notification_failed"});}
}
export function boundedSkillTask<T>(task:Promise<T>,milliseconds:number):Promise<T>{
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error("teams_skill_timeout")),milliseconds);
    task.then(resolve,reject).finally(()=>clearTimeout(timer));
  });
}
export async function acceptTeamsSkillJob(props:{actor:CanvasActor;conversation:string;activityId:string;value:unknown;send:(value:any)=>Promise<unknown>;budget?:SkillReceiptBudget;direct?:boolean;onCompleted?:()=>Promise<void>}):Promise<string> {
  const budget=props.budget??skillReceiptBudget("message");
  if(process.env.TEAMS_SKIP_AUTH?.trim().toLowerCase()==="true")throw Error("teams_skill_identity_required");
  const submission=skillSubmission(props.value),bot=process.env.TEAMS_BOT_ID||process.env.AZURE_AD_CLIENT_ID;
  if(!submission||!props.actor.salesforcePrincipal||!props.actor.email||!bot||!props.conversation||!props.activityId)throw Error("teams_skill_identity_required");
  const claim=verifySkillCard(submission.token,props.actor,props.conversation);
  if(submission.tokens!==undefined){
    if(!Array.isArray(submission.tokens)||submission.tokens.length!==2||submission.tokens[0]!==submission.token)throw Error("teams_skill_invalid_selection");
    const other=verifySkillCard(submission.tokens[1],props.actor,props.conversation);
    if(other.request!==claim.request||other.accounts||claim.accounts||other.skillId===claim.skillId)throw Error("teams_skill_invalid_selection");
  }
  if(active.size>=32)throw Error("teams_skill_busy");
  const owner="teams-skill-"+digest([bot,props.actor.salesforcePrincipal,props.actor.email.trim().toLowerCase()]);
  // Same signed button + same choices is one job even if Teams retries with a new activity ID.
  const id="teams-skill-job-"+digest(props.direct?[props.conversation,"direct",props.activityId]:[props.conversation,submission.token,submission.tokens,submission.accountId,submission.period]);
  const key=owner+":"+id;
  const container=HistoryContainer();
  const executionBudget=SKILL_SEARCH_LIMITS.milliseconds+10_000;
  const record:SkillJobRecord={id,userId:owner,type:TYPE,status:"running",deadline:Date.now()+executionBudget+5000,sentParts:0,ttl:86400};
  try {
    const wait=skillReceiptRemaining(budget,3000);
    const created=await boundedSkillTask(container.items.create(record,{abortSignal:AbortSignal.timeout(wait)}),wait);
    record._etag=created.resource?._etag;
  } catch(error) {
    if((error as {code?:number}).code!==409)throw error;
    const wait=skillReceiptRemaining(budget,3000);
    const {resource:existing}=await boundedSkillTask(container.item(id,owner).read<SkillJobRecord>({abortSignal:AbortSignal.timeout(wait)}),wait);
    if(!existing||existing.type!==TYPE||existing.userId!==owner||existing.id!==id)throw Error("teams_skill_invalid_job");
    if(existing.status==="succeeded")return "この操作の回答は送信済みです。チャットの回答をご確認ください。";
    if(existing.status==="failed")return FAILURE;
    if(existing.status==="delivery_uncertain")return UNCERTAIN;
    if(!active.has(key)&&existing.deadline<Date.now()){
      const interrupted={...existing,status:existing.status==="delivering"?"delivery_uncertain" as const:"failed" as const};
      const wait=skillReceiptRemaining(budget,3000);
      await boundedSkillTask(container.item(id,owner).replace(interrupted,{accessCondition:{type:"IfMatch",condition:existing._etag!},abortSignal:AbortSignal.timeout(wait)}),wait);
      return existing.status==="delivering"?UNCERTAIN:"前回受け付けたスキル処理が中断されています。自動再実行はしません。依頼を送り直してください。";
    }
    return "この操作は受付済みです。結果はチャットへ送信します。";
  }
  skillReceiptRemaining(budget,3000); // Never start work after a timed-out admission.
  if(!record._etag)throw Error("teams_skill_missing_job_etag");
  const save=async()=>{
    const {resource}=await container.item(id,owner).replace(record,{accessCondition:{type:"IfMatch",condition:record._etag!},abortSignal:AbortSignal.timeout(2000)});
    if(!resource?._etag)throw Error("teams_skill_missing_job_etag");record._etag=resource._etag;
  };
  // Keep a supervised promise, persist status, and never evict in-flight jobs.
  // App Service process restarts do not replay acknowledged work; the durable
  // deadline lets a later retry report interruption rather than duplicate sends.
  const run=new Promise<void>(resolve=>setImmediate(resolve)).then(async()=>{
    let sending=false;
    try {
      const signal=AbortSignal.timeout(executionBudget);
      const reply=await boundedSkillTask(handleTeamsSkill({...props,message:"",signal}),executionBudget+1000);
      record.status="delivering";record.deadline=Date.now()+60_000;await save();sending=true;
      await deliverTeamsSkillReply(reply,value=>{
        const remaining=record.deadline-Date.now();
        if(remaining<=0)throw Error("teams_skill_timeout");
        return boundedSkillTask(props.send(value),Math.min(10_000,remaining));
      },async()=>{record.sentParts++;await save();});
      record.status="succeeded";await save();
      try{if(props.onCompleted)await boundedSkillTask(props.onCompleted(),5000);}catch{console.warn("[teams-skill] job",{status:"usage_record_failed"});}
      console.info("[teams-skill] job",{status:"succeeded",sentParts:record.sentParts});
    }catch {
      record.status=sending?"delivery_uncertain":"failed";
      try{await save();}catch{console.warn("[teams-skill] job",{status:"state_write_failed"});}
      try{await boundedSkillTask(props.send(sending?UNCERTAIN:FAILURE),10_000);}catch{console.warn("[teams-skill] job",{status:"failure_notification_failed"});}
      console.info("[teams-skill] job",{status:record.status,sentParts:record.sentParts});
    }
  }).finally(()=>{active.delete(key);});
  active.set(key,run);
  console.info("[teams-skill] job",{status:"accepted"});
  return "受け付けました。スキルで情報を確認し、結果をこのチャットへ送信します。";
}
