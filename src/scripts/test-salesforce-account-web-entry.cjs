const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
process.env.SF_EXTENSION_ID='sf-test';process.env.BRAVE_SEARCH_DEFAULT_ENABLED='false';process.env.SKILL_SEARCH_ENABLED='false';
let records=[],allowed=true,fetches=[],modelCalls=0,nextBody,nextStatus=200,lastSummary;
const ok=response=>({status:'OK',response});
const original='Salesforceから取引先「J＆T環境㈱」の商談を取得し、完了予定日2026年1月1日〜3月31日の商談金額を月別合計してCanvasで棒グラフにしてください。';
const candidates=[{id:'001RA00001cNvJ7YAK',name:'Ｊ＆Ｔ環境株式会社 営業本部'},{id:'001A70000058uKbIAI',name:'J＆T環境株式会社　ソリューション営業室'}];
const services={
 AI_NAME:'Assistant',CHAT_DEFAULT_SYSTEM_PROMPT:'',
 resolveOfficeChatRoute:()=> 'extensions', shouldRouteToDeskNetsAgent:()=>false,
 getCurrentUser:async()=>({name:'test',email:'test@example.invalid'}),
 EnsureChatThreadOperation:async()=>ok({id:'test-thread',extension:['sf-test'],personaMessage:''}),
 prepareSkillsForChat:async()=>({selected:[]}),shouldRunSkillSearch:()=>false,readFiscalPeriod:()=>undefined,
 prepareAutomaticMemory:async()=>'',isDeskNetsAgentRequest:()=>false,isDeskNetsAgentFollowUpRequest:()=>false,isDeskNetsAgentEnabled:()=>false,
 isSalesforceAllowedEmail:()=>allowed,
 FindTopChatMessagesForCurrentUser:async()=>ok([...records].reverse()),mapOpenAIChatMessages:items=>items,
 CreateChatMessage:async item=>{records.push({...item});return ok(item);},
 FindAllChatDocuments:async()=>ok([]),GetDefaultExtensions:async()=>ok([]),GetDynamicExtensions:async()=>ok([]),
 FindExtensionByID:async()=>ok({executionSteps:''}),
 isSharePointImageRequest:()=>false,isAttachedPptConversionRequest:()=>false,isNewPptCreationRequest:()=>false,isExplicitPptOutputRequest:()=>false,isPptxAssetPlacementRequest:()=>false,
 resolveRequiredImageToolName:()=>undefined,resolvePptxPaletteInstruction:()=>undefined,
 skillAuthoringInstructions:()=>'',skillReferenceLabel:()=>'',inferSlSearchTarget:()=>({}),
 OpenAIInstance:()=>({beta:{chat:{completions:{stream:args=>{lastSummary=args;modelCalls++;return load('features/common/services/salesforce-clarification-stream.ts').salesforceTextStream('参照権限を確認できません。',new AbortController().signal);}}}}}),
 OpenAIStream:({runner})=>new ReadableStream({async start(controller){try{const content=await runner.finalContent();records.push({role:'assistant',content});controller.enqueue(new TextEncoder().encode(content));controller.close();}catch(error){controller.error(error);}}}),
};
const cache=new Map();
function load(relative){const filename=path.resolve(__dirname,'..',relative);if(cache.has(filename))return cache.get(filename);const mod=new Module(filename);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));const normal=mod.require.bind(mod);mod.require=name=>{
 if(name==='server-only')return {};
 if(name==='./chat-api-extension')return load('features/chat-page/chat-services/chat-api/chat-api-extension.ts');
 if(name.startsWith('@/features/common/services/salesforce-')&&!name.endsWith('/salesforce-access'))return load(name.slice(2)+'.ts');
 if(name.startsWith('@/')||name.startsWith('../')||name.startsWith('./'))return services;
 return normal(name);
};mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,filename);cache.set(filename,mod.exports);return mod.exports;}
global.fetch=async url=>{fetches.push(new URL(url));return {status:nextStatus,ok:nextStatus>=200&&nextStatus<300,json:async()=>nextBody};};
async function main(){
 const {ChatAPIEntry}=load('features/chat-page/chat-services/chat-api/chat-api.ts');
 const run=async message=>(await ChatAPIEntry({id:'test-thread',message},new AbortController().signal)).text();
 nextBody={ok:true,status:'needs_account_selection',account_candidates:candidates};
 const question=await run(original);assert.ok(question.startsWith('Salesforceの取引先を選択してください。'));assert.equal(modelCalls,0);
 assert.equal(records.filter(item=>item.role==='tool').length,1);
 nextBody={ok:true,status:'ok',count:2,items:[],request_plan:{account_name:'J＆T環境㈱',account_id:candidates[1].id,resolved_account_name:candidates[1].name,dateRange:{start:'2026-01-01',end:'2026-03-31'},aggregation:{interval:'month',func:'SUM'}},analysis:{complete:true,items:[{period:'2026-01',value:'60000',record_count:1},{period:'2026-03',value:'23000',record_count:1}]}};
 const answer=await run('2番で');assert.ok(answer.includes('60,000')&&answer.includes('23,000')&&answer.includes('83,000 円'));assert.ok(answer.startsWith('<!-- salesforce:monthly-report -->'));
 assert.equal(fetches[1].searchParams.get('account_id'),candidates[1].id);assert.ok(fetches[1].searchParams.get('q').includes('2026年1月1日〜3月31日'));assert.equal(modelCalls,0);
 assert.ok(!fetches[0].searchParams.has('account_id'));
 records=[];nextBody={ok:true,status:'needs_account_selection',account_candidates:candidates};await run(original);
 const before=fetches.length;const invalid=await run('9番で');assert.ok(invalid.includes('選び直してください'));assert.equal(fetches.length,before);
 records=[];await run(original);allowed=false;const deniedBefore=fetches.length;await run('2番で');assert.equal(fetches.length,deniedBefore,'whitelist revoked: no Salesforce query');
 allowed=true;records=[];const callsBeforeErrors=modelCalls;
 nextStatus=503;nextBody={ok:false,error:'semantic_plan_unavailable'};
 assert.ok((await run('私の部下の取引先を挙げて')).includes('一時的に依頼文を解析できません'));
 nextStatus=502;nextBody={ok:false,error:'owner_scope_unavailable'};
 assert.ok((await run('部下の取引先を挙げて')).includes('本人の担当分で代用せず'));
 assert.equal(modelCalls,callsBeforeErrors,'known scope/interpretation failures do not invoke a summary model');
 nextStatus=200;nextBody={ok:true,object:'Account',items:[{Name:'Test'}],count:20,total_count:null,truncated:true,request_plan:{owner_scope:'my_team'},applied_owner_scope:{scope:'my_team',notice:'下位ロールが対象です。本人は含みません。'},table_instruction:'取得上限の一部です。'};
 await run('部下の取引先を挙げて');
 const system=lastSummary.messages.find(item=>item.role==='system').content;
 assert.ok(system.includes('本人は含みません'));assert.ok(system.includes('取得件数を全件数として説明しない'));
 assert.ok(!system.includes('全0件')&&!system.includes('total_count=0'));
 const beforeCount=modelCalls;
 nextBody={ok:true,object:'Account',count:0,items:[],total_count:47846,aggregation_result:{func:'COUNT',value:47846,scope:'all',source:'soql_count'},execution_summary:{object:'Account',scope:'all',method:'Salesforce COUNT()',filters:[]}};
 const exact=await run('取引先オブジェクトの件数を教えて');
 assert.ok(exact.includes('47,846')&&exact.includes('COUNT()'));assert.equal(modelCalls,beforeCount);
 nextBody={ok:true,status:'conversation',items:[],count:0};
 assert.equal(await run('では、質問を変えます。'),'どうぞ、ご質問ください。');assert.equal(modelCalls,beforeCount);
 console.log('PASS actual Web entry: account selection, owner scope, authoritative COUNT without summary LLM, conversation');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
