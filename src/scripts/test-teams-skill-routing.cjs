const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const handlers={},skillCalls=[];let pendingOffice,scheduling,normalCalls=0,identityFails=false;
const actor={email:'owner@example.test',salesforcePrincipal:'tenant:owner'};
Object.assign(process.env,{TEAMS_ENABLED:'true',TEAMS_BOT_ID:'bot',TEAMS_BOT_SECRET:'test-only',TEAMS_TENANT_ID:'tenant',TEAMS_SKIP_AUTH:'false',SKILL_SEARCH_ENABLED:'true',SF_PERSONAL_MODE:'false'});
const stubs={
 'server-only':{},
 '@microsoft/teams.apps':{App:class{on(name,handler){handlers[name]=handler;}async initialize(){}}},
 './next-http-adapter':{NextHttpAdapter:class{}},
 './teams-skill-service':{skillSubmission:()=>undefined,handleTeamsSkill:async props=>{skillCalls.push(props.message);return {card:{type:'AdaptiveCard',body:[],actions:[]}};}},
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
 console.log('PASS actual Teams message route: general Skill candidates, Office/scheduling priority, personal-chat scope, feature flag and long-chat fallback');
})().catch(error=>{console.error(error);process.exitCode=1;});
