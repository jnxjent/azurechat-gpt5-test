const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const handlers={},skillCalls=[],acceptedJobs=[];let pendingOffice,scheduling,normalCalls=0,identityFails=false;
const actor={email:'owner@example.test',salesforcePrincipal:'tenant:owner'};
Object.assign(process.env,{TEAMS_ENABLED:'true',TEAMS_BOT_ID:'bot',TEAMS_BOT_SECRET:'test-only',TEAMS_TENANT_ID:'tenant',TEAMS_SKIP_AUTH:'false',SKILL_SEARCH_ENABLED:'true',SF_PERSONAL_MODE:'false'});
const stubs={
 'server-only':{},
 '@microsoft/teams.apps':{App:class{on(name,handler){handlers[name]=handler;}async initialize(){}}},
 './next-http-adapter':{NextHttpAdapter:class{}},
 '@/features/skills/skill-rules':{requestsSkillReference:text=>text.startsWith('Skill')},
 './teams-skill-jobs':{acceptTeamsSkillJob:async props=>{acceptedJobs.push(props);return 'accepted';},boundedSkillTask:p=>p,skillReceiptBudget:()=>({deadline:Date.now()+9500}),skillReceiptRemaining:(_b,max)=>max,sendSkillReceipt:(send,receipt)=>send(receipt)},
 './teams-skill-delivery':{deliverTeamsSkillReply:async(reply,send)=>{if(reply.text)await send(reply.text);if(reply.card)await send({type:'message',attachments:[{contentType:'application/vnd.microsoft.card.adaptive',content:reply.card}]});}},
 './teams-skill-service':{skillSubmission:value=>value?.feature==='ac.skill'?value:undefined,handleTeamsSkill:async props=>{skillCalls.push(props.message);assert.equal(props.prepareOnly,true);return props.message.startsWith('Skill')?{preparedSubmission:{feature:'ac.skill',token:'direct'}}:{card:{type:'AdaptiveCard',body:[],actions:[]}};}},
 './teams-canvas-service':{isTeamsCanvasRequest:()=>false,resolveTeamsSkillActor:async activity=>{if(identityFails)throw Error('identity unavailable');assert.equal(activity.conversation.conversationType,'personal');return actor;}},
 './teams-file-service':{receiveTeamsFiles:async()=>[],readLatestTeamsFiles:async()=>[],buildTeamsTextAttachmentContext:()=>''},
 './teams-file-policy':{stripTeamsAttachmentMarkup:text=>text,referencesTeamsUpload:()=>false},
 './teams-instant-reply':{resolveTeamsInstantReply:()=>undefined},
 './teams-office-service':{buildTeamsThreadId:id=>'teams-'+id,parseTeamsOfficeRequest:()=>undefined,executePendingTeamsOfficeSelection:async()=>pendingOffice},
 './teams-usage-service':{recordTeamsThreadUsage:async()=>{},recordTeamsChatTurn:async()=>{}},
 '@/features/memory/automatic-memory-service':{prepareTeamsAutomaticMemory:async()=>''},
 './teams-desknets-service':{handleTeamsDeskNets:async()=>scheduling},
 '@/features/common/services/salesforce-access':{isSalesforceAllowedEmail:()=>false},
 './teams-salesforce-routing':{resolveTeamsSalesforceRoute:async()=>({route:'normal'})},
 './teams-salesforce-service':{isTeamsSalesforceConfigured:()=>false},
 './teams-search-service':{isTeamsSearchConfigured:()=>false},
 './teams-brave-search-service':{isTeamsBraveSearchConfigured:()=>false},
 './teams-image-intent':{isTeamsImageGenerationRequest:()=>false},
 './teams-image-service':{},
 '@/features/common/services/salesforce-personal':{personalSalesforceForEmail:()=>false},
 './teams-chat-service':{createTeamsChatReply:async()=>{normalCalls++;return {type:'reply',text:'normal reply'};}},
 '@/features/pptx/output-intent':{isExcelTableToSlideRequest:()=>false},
};
const loaded={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../features/teams/teams-app.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(id=>{if(Object.hasOwn(stubs,id))return stubs[id];throw Error('Unexpected dependency '+id);},loaded,loaded.exports);
let serial=0;
async function message(text,type='personal'){
 const sent=[];
 await handlers.message({activity:{id:String(++serial),channelId:'msteams',text,conversation:{id:'conversation',conversationType:type},from:{id:'user'}},send:async item=>sent.push(item),api:{conversations:{members:()=>({getById:async()=>({email:actor.email})})}}});
 return sent;
}
(async()=>{
 await loaded.exports.getTeamsRuntime();
 const buttonSends=[];
 const button={activity:{id:'button',channelId:'msteams',conversation:{id:'conversation',conversationType:'personal'},from:{id:'user'},value:{feature:'ac.skill',token:'fixture'}},api:{},send:async value=>buttonSends.push(value)};
 const receipt=await handlers['card.action'](button);
 assert.equal(receipt.value,'accepted');assert.equal(acceptedJobs.length,1);assert.equal(buttonSends.length,0,'Card action returns only ACK; no final report in send and invoke');
 await handlers['message.ext.card-button-clicked'](button);assert.equal(acceptedJobs.length,2);assert.deepEqual(buttonSends,['accepted']);
 let sent=await message('黄さんの営業進捗をレポートにまとめて');
 assert.equal(skillCalls.length,1);assert.equal(sent[0].attachments[0].content.type,'AdaptiveCard');
 sent=await message('倉庫の在庫補充計画を立てて');assert.equal(skillCalls.length,2,'arbitrary Skills reach candidate matching without a fixed intent gate');
 pendingOffice='Office selection completed';sent=await message('黄さんの営業進捗をレポートにまとめて');
 assert.equal(sent[0],pendingOffice);assert.equal(skillCalls.length,2,'pending Office choices take priority over Skill suggestions');pendingOffice=undefined;
 scheduling={text:'schedule reply'};sent=await message('会議の日程候補を教えて');
 assert.equal(sent[0],scheduling.text);assert.equal(skillCalls.length,2);scheduling=undefined;
 await message('黄さんの営業進捗をレポートにまとめて','groupChat');assert.equal(skillCalls.length,2);assert.equal(normalCalls,1);
 process.env.SKILL_SEARCH_ENABLED='false';await message('黄さんの営業進捗をレポートにまとめて');assert.equal(skillCalls.length,2);assert.equal(normalCalls,2);
 process.env.SKILL_SEARCH_ENABLED='true';await message('普通の長い質問'.repeat(500));assert.equal(skillCalls.length,2);assert.equal(normalCalls,3,'long ordinary chat must not get the Skill input-length error');
 identityFails=true;process.env.TEAMS_SKIP_AUTH='true';
 sent=await message('黄さんの営業進捗をレポートにまとめて');
 assert.ok(sent[0].includes('本人確認'));assert.equal(normalCalls,3);assert.equal(skillCalls.length,2,'Unauthenticated sales report must not search SF or internal documents');
 await message('こんにちは、今日もよろしく');assert.equal(normalCalls,4,'Ordinary conversation remains available');
 identityFails=false;
 const direct=await message('Skill「営業進捗」を使って、黄さんの状況をまとめて');
 assert.ok(direct.includes('accepted'));assert.equal(acceptedJobs.at(-1).direct,true);assert.equal(typeof acceptedJobs.at(-1).onCompleted,'function');
 console.log('PASS actual Teams message route: general Skill candidates, Office/scheduling priority, personal-chat scope, feature flag and long-chat fallback');
})().catch(error=>{console.error(error);process.exitCode=1;});
