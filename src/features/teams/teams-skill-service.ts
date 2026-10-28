import "server-only";
import type { IAdaptiveCard } from "@microsoft/teams.cards";
import { withCanvasActor, type CanvasActor } from "@/features/canvas/canvas-actor";
import { listActorSkills } from "@/features/skills/skill-service";
import { formatSkillContext, requestsSkillReference, selectSkills, skillName, type UserSkill } from "@/features/skills/skill-rules";
import { applySkillSuggestion, suggestSkills } from "@/features/skills/skill-suggestions";
import { runSkillSearch } from "@/features/skills/execution/skill-search-runner";
import { shouldRunSkillSearch } from "@/features/skills/execution/skill-search-policy";
import { readFiscalPeriod } from "@/features/skills/execution/skill-search-requirements";
import { issueSkillCard, verifySkillCard, skillSubmission, type SkillCardClaim } from "./teams-skill-card";
import { searchTeamsKnowledgeWithTarget } from "./teams-search-service";
import { finalizeSkillReport } from "@/features/skills/execution/skill-report-output";
import { SKILL_SEARCH_LIMITS } from "@/features/skills/execution/skill-search-policy";

export { skillSubmission } from "./teams-skill-card";
export type TeamsSkillReply = { text?: string; card?: IAdaptiveCard; cardKind?: "suggestions"|"account"|"period"; preparedSubmission?:Record<string,unknown> };
const executions = new Map<string, Promise<TeamsSkillReply | undefined>>();
/** Only SDK-authenticated, personal-chat roster identities may enter this function. */
export async function handleTeamsSkill(props: { actor: CanvasActor; conversation: string; activityId: string; message: string; value?: unknown; onWaiting?: () => Promise<void>; signal?:AbortSignal; prepareOnly?:boolean }): Promise<TeamsSkillReply | undefined> {
  const key = JSON.stringify([props.actor.salesforcePrincipal, props.conversation, props.activityId,props.prepareOnly===true]);
  if (props.activityId && executions.has(key)) return executions.get(key);
  const run = withCanvasActor(props.actor, () => execute(props));
  if (props.activityId) {
    executions.set(key, run);
    // Only in-flight/completed turn deduplication; no cross-turn model history or SF results.
    run.finally(() => { setTimeout(() => executions.delete(key), 60_000).unref(); }).catch(() => {});
    while (executions.size > 300) executions.delete(executions.keys().next().value!);
  }
  return run;
}
async function execute(props: Parameters<typeof handleTeamsSkill>[0]): Promise<TeamsSkillReply | undefined> {
  const submission = skillSubmission(props.value);
  if (!shouldRunSkillSearch(1)) return submission || /Skill|スキル/i.test(props.message) ? {text:"スキル検索が有効になっていません。"} : undefined;
  if (props.message.length > 2000) return submission || /Skill|スキル/i.test(props.message) ? {text:"スキルへの依頼は2,000文字以内にまとめてください。"} : undefined;
  const skills = await listActorSkills().catch(() => undefined);
  if (!skills) return submission || /Skill|スキル/i.test(props.message) ? {text:"保存済みスキルを取得できませんでした。しばらくしてから再度お試しください。"} : undefined;
  let selected: UserSkill[] = [], original = props.message;
  let selectedAccount: {id:string;name:string} | undefined;
  if (submission) {
    let claim: SkillCardClaim;
    try { claim = verifySkillCard(submission.token, props.actor, props.conversation); }
    catch { return {text:"このスキル候補は期限切れ、または本人確認ができません。依頼を送り直してください。"}; }
    const skill = skills.find(s => s.id === claim.skillId && s.enabled && s.version === claim.version);
    if (!skill) return {text:"スキルが変更・非公開・無効化されています。依頼を送り直してください。"};
    selected = [skill]; original = claim.request;
    if(submission.tokens!==undefined){
      if(!Array.isArray(submission.tokens)||submission.tokens.length!==2||submission.tokens[0]!==submission.token)return {text:"スキルの指定を確認できません。依頼を送り直してください。"};
      try{
        const second=verifySkillCard(submission.tokens[1],props.actor,props.conversation);
        const other=skills.find(s=>s.id===second.skillId&&s.enabled&&s.version===second.version);
        if(!other||second.request!==original||second.accounts||claim.accounts||other.id===skill.id)throw Error();
        selected.push(other);
      }catch{return {text:"スキルが変更されたか、指定を確認できません。依頼を送り直してください。"};}
    }
    if (claim.accounts) {
      if (typeof submission.accountId !== "string" || !claim.accounts.includes(submission.accountId)) return {text:"カードから取引先を選択してください。"};
      // The runner re-reads this ID using current SF permissions; no stored record is trusted.
      selectedAccount = {id:submission.accountId,name:"選択した取引先"};
    }
    if (submission.period !== undefined && (typeof submission.period !== "string" || submission.period.length > 120 || !readFiscalPeriod(submission.period))) return {text:"期間は「2025年4月～2026年3月」の形式で入力してください。"};
  } else {
    if (requestsSkillReference(props.message)) selected = selectSkills(skills, props.message);
    if (new Set(selected.map(skill => skillName(skill.title))).size !== selected.length) selected = [];
    if (!selected.length) {
      const candidates = suggestSkills(skills, props.message);
      if (!candidates.length || props.message.length > 2000) return /Skill|スキル/i.test(props.message) ? {text:"指定された有効なスキルが見つかりません。Web版のSkillsで保存名を確認してください。"} : undefined;
      return {cardKind:"suggestions",card:{type:"AdaptiveCard",version:"1.4",fallbackText:"スキルの選択・確認カードです。TeamsのWeb版またはデスクトップ版で開いてください。",body:[{type:"TextBlock",text:"この依頼に使えそうなスキル",weight:"Bolder",wrap:true},{type:"TextBlock",text:"選ぶと、この依頼に適用して実行します。",wrap:true}],actions:candidates.map(s => ({type:"Action.Submit",title:s.title+(s.scope === "shared" ? `（全社公開・${s.ownerName ?? "社員"}）` : ""),data:{feature:"ac.skill",token:issueSkillCard(props.actor,props.conversation,{skillId:s.id,version:s.version,request:props.message})}}))}};
    }
  }
  formatSkillContext(selected);
  if(props.prepareOnly){
    const tokens=selected.map(skill=>issueSkillCard(props.actor,props.conversation,{skillId:skill.id,version:skill.version,request:original}));
    return {preparedSubmission:{feature:"ac.skill",token:tokens[0],...(tokens.length>1?{tokens}: {})}};
  }
  await props.onWaiting?.();
  const message = typeof submission?.period === "string" ? submission.period : applySkillSuggestion(original, selected[0]);
  const result = await runSkillSearch({chatThread:{id:`teams-${props.conversation}`},skills:selected,message,originalRequest:original,history:[],email:props.actor.email,signal:props.signal ?? AbortSignal.timeout(SKILL_SEARCH_LIMITS.milliseconds),selectedAccount,
    documentSearch: async query => {
      const result = await searchTeamsKnowledgeWithTarget({query,userEmail:props.actor.email});
      return {source:"documents",status:result.sources.length ? "ok" : "empty",data:{context:result.context,sources:result.sources},message:"本人の部署・個人ACLで検索した抜粋です。Teamsでは実際に返ったURLのみ引用する。"};
    },
  });
  const completion=result.runner?await result.runner.finalChatCompletion():undefined;
  const final = result.directContent ?? finalizeSkillReport(result.runner!, completion?.choices[0]?.message.content ?? "回答を作成できませんでした。",completion);
  for (const raw of result.citationResults) {
    let state: Record<string, any>;
    try {state=JSON.parse(raw);} catch {continue;}
    if (selected.length !== 1) continue;
    const common = {skillId:selected[0].id,version:selected[0].version,request:original};
    if (state.integration === "skill_search_account_candidates" && Array.isArray(state.records)) {
      const records = state.records.filter((r: any) => /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(r.Id) && typeof r.Name === "string").slice(0,50);
      if (!records.length) continue;
      const token = issueSkillCard(props.actor,props.conversation,{...common,accounts:records.map((r: any) => r.Id)});
      return {text:final,cardKind:"account",card:{type:"AdaptiveCard",version:"1.4",fallbackText:"スキルの選択・確認カードです。TeamsのWeb版またはデスクトップ版で開いてください。",body:[{type:"TextBlock",text:"訪問先の取引先を選択してください",wrap:true},{type:"Input.ChoiceSet",id:"accountId",style:"compact",choices:records.map((r: any) => ({title:r.Name,value:r.Id}))}],actions:[{type:"Action.Submit",title:"選択して続行",data:{feature:"ac.skill",token}}]}};
    }
    if (state.integration === "skill_search_fiscal_pending" && state.account?.id) {
      const token = issueSkillCard(props.actor,props.conversation,{...common,accounts:[state.account.id]});
      return {text:final,cardKind:"period",card:{type:"AdaptiveCard",version:"1.4",fallbackText:"スキルの選択・確認カードです。TeamsのWeb版またはデスクトップ版で開いてください。",body:[{type:"TextBlock",text:"売上集計の期間を指定して続行",wrap:true},{type:"Input.Text",id:"period",placeholder:"2025年4月～2026年3月"}],actions:[{type:"Action.Submit",title:"この期間で続行",data:{feature:"ac.skill",token,accountId:state.account.id}}]}};
    }
  }
  return {text:final};
}
