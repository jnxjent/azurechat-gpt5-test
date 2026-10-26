const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
process.env.SF_EXTENSION_ID='sf-test';process.env.BRAVE_SEARCH_DEFAULT_ENABLED='false';process.env.SKILL_SEARCH_ENABLED='false';
let records=[],allowed=true,fetches=[],modelCalls=0,nextBody,nextStatus=200,lastSummary,opportunityToken;
const ok=response=>({status:'OK',response});
const original='Salesforceから取引先「J＆T環境㈱」の商談を取得し、完了予定日2026年1月1日〜3月31日の商談金額を月別合計してCanvasで棒グラフにしてください。';
const candidates=[{id:'001RA00001cNvJ7YAK',name:'Ｊ＆Ｔ環境株式会社 営業本部'},{id:'001A70000058uKbIAI',name:'J＆T環境株式会社　ソリューション営業室'}];
const services={
 resolveOfficeChatRoute:()=> 'extensions',
 readOpportunityContext:async()=>({id:'context',owner:'owner',threadId:'test-thread',token:opportunityToken}),
 saveOpportunityContext:async(previous,token)=>{opportunityToken=token;},
 AI_NAME:'Assistant',CHAT_DEFAULT_SYSTEM_PROMPT:'',
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
 if(name==='@/features/common/services/salesforce-opportunity-context')return services;
 if(name==='./chat-api-extension')return load('features/chat-page/chat-services/chat-api/chat-api-extension.ts');
 if(name.startsWith('@/features/common/services/salesforce-')&&!name.endsWith('/salesforce-access'))return load(name.slice(2)+'.ts');
 if(name.startsWith('@/')||name.startsWith('../')||name.startsWith('./'))return services;
 return normal(name);
};mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,filename);cache.set(filename,mod.exports);return mod.exports;}
let responseHeaders=new Headers(),lastRequestHeaders;
global.fetch=async (url,options)=>{fetches.push(new URL(url));lastRequestHeaders=options?.headers;return {headers:responseHeaders,status:nextStatus,ok:nextStatus>=200&&nextStatus<300,json:async()=>nextBody};};
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
 const brief='J＆T環境の初回訪問用の資料をCanvasで作って';
 records=[];nextBody={ok:true,status:'needs_account_selection',account_candidates:candidates};
 await run(brief);
 assert.equal(fetches.at(-1).searchParams.get('presentation'),'canvas');
 nextBody={ok:true,object:'Account',items:[{Id:candidates[1].id,Name:candidates[1].name}],count:1,request_plan:{account_name:'J＆T環境',account_id:candidates[1].id}};
 await run('2番で');
 assert.equal(fetches.at(-1).searchParams.get('presentation'),'canvas');
 assert.equal(fetches.at(-1).searchParams.get('account_id'),candidates[1].id);
 assert.equal(lastSummary.messages.find(item=>item.role==='user').content,brief,'retain document purpose after selecting an account');
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
 // Personal mode must reject an old/shared Gateway even when it returns valid COUNT JSON.
 process.env.SF_PERSONAL_MODE='true';process.env.SF_PERSONAL_SNAPSHOT_POLICY='strict';process.env.SF_PERSONAL_SIGNING_KEY='x'.repeat(40);process.env.SF_GATEWAY_BASE_URL='https://gateway.example.com';
 const principal='11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
 process.env.SF_PERSONAL_USERS_JSON=JSON.stringify([{principal,email:'test@example.invalid'}]);process.env.SF_PERSONAL_GATEWAY_BASE_URL='https://personal.example.com';
 services.getCurrentUser=async()=>({name:'test',email:'test@example.invalid',salesforcePrincipal:principal});
 records=[];nextBody={ok:true,object:'Account',count:0,items:[],aggregation_result:{func:'COUNT',value:47846,scope:'all',source:'soql_count'}};
 const rejected=await run('取引先の登録件数を教えて');assert.ok(!rejected.includes('47,846'));
 assert.ok(lastRequestHeaders['X-AC-Identity']&&lastRequestHeaders['X-AC-Signature']);
 responseHeaders=new Headers({'X-SF-Connection-Mode':'personal-jwt','X-AC-Principal':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'});
 records=[];const personal=await run('取引先の登録件数を教えて');assert.ok(personal.includes('47,846')&&personal.includes('あなたが閲覧できる'));
 services.getCurrentUser=async()=>({name:'test',email:'test@example.invalid'});
 records=[];const noPrincipalCalls=fetches.length;await run('取引先の登録件数を教えて');assert.equal(fetches.length,noPrincipalCalls);
 delete process.env.SF_PERSONAL_MODE;delete process.env.SF_PERSONAL_SNAPSHOT_POLICY;delete process.env.SF_PERSONAL_SIGNING_KEY;
 process.env.SF_OPPORTUNITY_POPULATION_ENABLED='true';records=[];nextStatus=200;
 const beforePopulationModelCalls=modelCalls;
 nextBody={ok:true,status:'opportunity_population',population_context:'signed-scope-1',population_text:'母集団：31アカウント／条件：進行中',items:[]};
 assert.equal(await run('J＆T環境㈱の進行中の商談'),'母集団：31アカウント／条件：進行中');assert.equal(opportunityToken,'signed-scope-1');
 nextBody={ok:true,status:'opportunity_population',population_context:'signed-scope-2',population_text:'母集団：31アカウント／条件：失注',items:[]};
 assert.equal(await run('失注'),'母集団：31アカウント／条件：失注');assert.equal(lastRequestHeaders['X-SF-Opportunity-Context'],'signed-scope-1');
 assert.equal(lastRequestHeaders['X-SF-Opportunity-Population'],'v1');
 nextBody={ok:true,status:'opportunity_population',population_context:'signed-scope-3',population_text:'対象：24番／条件：失注',items:[]};
 assert.equal(await run('24'),'対象：24番／条件：失注');assert.equal(lastRequestHeaders['X-SF-Opportunity-Context'],'signed-scope-2');assert.equal(fetches.at(-1).searchParams.get('q'),'24');
 assert.equal(modelCalls,beforePopulationModelCalls,'population results must not be summarized, truncated or expose the signed scope to the model');
 nextBody={ok:true,status:'conversation'};await run('ありがとう');assert.equal(opportunityToken,undefined,'independent conversation clears the active population');
 delete process.env.SF_OPPORTUNITY_POPULATION_ENABLED;
 console.log('PASS actual Web entry: account selection, owner scope, authoritative COUNT without summary LLM, conversation');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
