const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {EventEmitter} = require('node:events');
let allowed=true, configured=true, docIdentity=true, fetchMode='ok', fetched=[], docCalls=[], planning=[], finals=[], plan=[], fetchQueue=[], webError;
const stubs={
 'server-only':{},
 '@/features/common/services/salesforce-access':{isSalesforceAllowedEmail:()=>allowed},
 '@/features/common/services/salesforce-routing':{buildSalesforceGatewayQuery:q=>q},
 '@/features/chat-page/chat-services/azure-ai-search/azure-ai-search':{ExtensionSimilaritySearch:async p=>{docCalls.push(p);return {status:'OK',response:[{document:{metadata:'規程.pdf',pageContent:'検証用本文'}}]};}},
 '@/features/chat-page/chat-services/chat-api/chat-api-rag':{resolveUserContext:async()=>({email:docIdentity?'user@test':'other@test',deptLower:'sales',userHash:'trusted-hash'})},
 '@/features/chat-page/chat-services/citation-service':{FormatCitations:x=>x,CreateCitations:async x=>x.map(content=>({status:'OK',response:{id:'citation-1',content}}))},
 '@/features/teams/teams-brave-search-service':{isTeamsBraveSearchConfigured:()=>configured,searchBraveWeb:async()=>{if(webError)throw Error(webError);return {context:'公開ニュース',sources:[{name:'公式',url:'https://example.test/news'}]};}},
 '@/features/common/services/openai': { OpenAIInstance: () => ({
   chat: { completions: { create: async p => {
     planning.push(structuredClone(p));
     return { choices: [{ message: plan.shift() || {role:'assistant',content:'ready'} }] };
   } } },
   beta: { chat: { completions: { stream: p => {
     finals.push(structuredClone(p)); const e=new EventEmitter(); setImmediate(()=>e.emit('end')); return e;
   } } } },
 }) },
};
const cache=new Map();
function load(file){
 file=path.resolve(__dirname,'..',file);if(cache.has(file))return cache.get(file);
 const module={exports:{}};cache.set(file,module.exports);
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',js)(id=>{
  if(Object.hasOwn(stubs,id))return stubs[id];
  if(id.startsWith('.'))return load(path.resolve(path.dirname(file),id+'.ts'));
  if(id.startsWith('@/'))return load(id.slice(2)+'.ts');
  return require(id);
 },module,module.exports);cache.set(file,module.exports);return module.exports;
}
global.fetch=async(url,options)=>{fetched.push({url:new URL(url),options});if(fetchQueue.length){const body=fetchQueue.shift();return {ok:true,status:200,json:async()=>structuredClone(body)};}if(fetchMode==='throw')throw Error('private secret');return {ok:fetchMode!=='denied',status:fetchMode==='denied'?403:200,json:async()=>fetchMode==='empty'?{items:[]}:fetchMode==='error'?{ok:false,error:'private'}:fetchMode==='malformed'?{}:{items:[{Id:'001test',Name:'検証会社',lightning_url:'https://example.test/account'}],total_count:1}};};
const policy=load('features/skills/execution/skill-search-policy.ts');
const {createSkillSearchTools}=load('features/skills/execution/skill-search-tools.ts');
const {runSkillSearch}=load('features/skills/execution/skill-search-runner.ts');
const sfQuery=load('features/skills/execution/salesforce-search-query.ts');
const continuation=load('features/skills/execution/skill-search-continuation.ts');
const requirements=load('features/skills/execution/skill-search-requirements.ts');
const props={email:'user@test',threadId:'thread-1',signal:new AbortController().signal,userMessage:'部署共通から検索'};
const toolCall=(source,index=1)=>({role:'assistant',content:null,tool_calls:[{id:'call-'+index,type:'function',function:{name:'skill_search_'+source,arguments:JSON.stringify({query:source==='salesforce'?'取引先の検証会社について教えて':'検証会社 情報'})}}]});
async function main(){
 assert.deepEqual(requirements.readFiscalPeriod('前会計年度は2025年4月～2026年3月です'),{fiscalStart:'2025-04-01',fiscalEnd:'2026-04-01'});
 assert.deepEqual(requirements.readFiscalPeriod('2025-04-01～2026-03-31'),{fiscalStart:'2025-04-01',fiscalEnd:'2026-04-01'});
 assert.deepEqual(requirements.readFiscalPeriod('前年度',new Date('2026-10-19T00:00:00Z')),{fiscalStart:'2025-04-01',fiscalEnd:'2026-04-01'});
 assert.equal(requirements.readFiscalPeriod('2025-02-30～2026-02-28'),undefined);
 const requiredSkills=[{content:'Salesforce Account Opportunity Activity Sales__c Billing__c Slack Canvas Webニュース'}];
 assert.deepEqual(requirements.skillSearchRequirements(requiredSkills,'J&T環境株式会社を調べて').operations,['accounts','opportunities','activities','sales']);
 assert.deepEqual(requirements.skillSearchRequirements(requiredSkills,'今回は売上の年度集計を省略してください').operations,['accounts','opportunities','activities']);
 assert.deepEqual(requirements.skillSearchRequirements(requiredSkills,'Salesforceは使用しない。Webのみ検索').operations,[]);
 assert.equal(requirements.skillSearchRequirements(requiredSkills,'Web検索は使わない').web,false);
 assert.ok(requirements.SKILL_RESULT_PRESENTATION.includes('Markdown表'));
 assert.deepEqual(requirements.skillSearchRequirements([{content:'Salesforce Sales__cの前会計年度を集計'}],'調べて').fiscalPeriod,requirements.readFiscalPeriod('前年度'));
 assert.deepEqual(requirements.skillSearchRequirements([{content:'Salesforce Sales__cの前会計年度を集計'}],'今期の上期を調べて').fiscalPeriod,requirements.readFiscalPeriod('今期の上期'));
 assert.equal(requirements.skillSearchRequirements([{content:'Salesforce Sales__cの前会計年度を集計'}],'2026年4月1日から2026年3月31日を集計').fiscalPeriod,undefined);

 process.env.SKILL_SEARCH_ENABLED='false';assert.equal(policy.shouldRunSkillSearch(1),false);
 process.env.SKILL_SEARCH_ENABLED='true';assert.equal(policy.shouldRunSkillSearch(0),false);assert.equal(policy.shouldRunSkillSearch(1),true);
 process.env.SF_GATEWAY_BASE_URL='https://gateway.test';process.env.AZURE_SEARCH_API_KEY='private';process.env.AZURE_SEARCH_NAME='test';process.env.AZURE_SEARCH_INDEX_NAME='test';
 assert.throws(()=>policy.validateSearchQuery(' '));assert.throws(()=>policy.validateSearchQuery('x'.repeat(601)));
 const bounded=policy.boundSearchResult({source:'salesforce',status:'ok',data:Array.from({length:80},()=>({text:'あ'.repeat(300)}))});assert.equal(bounded.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=16000);
 let t=createSkillSearchTools(props);allowed=false;assert.equal((await t.execute('salesforce','会社')).status,'denied');assert.equal(fetched.length,0);allowed=true;
 for(const [mode,status] of [['empty','empty'],['denied','denied'],['error','error'],['malformed','error'],['throw','error'],['ok','ok']]){fetchMode=mode;t=createSkillSearchTools(props);const r=await t.execute('salesforce','取引先の検証会社について教えて');assert.equal(r.status,status);assert.ok(!JSON.stringify(r).includes('private'));}
 assert.equal(fetched.at(-1).options.headers['X-User-Email'],'user@test');assert.match(fetched.at(-1).options.headers['X-Chat-Thread-Id'],/^skill-read-v1:/);assert.notEqual(fetched.at(-1).options.headers['X-Chat-Thread-Id'],'thread-1');assert.equal(fetched.at(-1).url.pathname,'/api/sf/query_nl');assert.equal(fetched.at(-1).url.searchParams.get('mode'),'real');
 const beforeMissing=fetched.length;delete process.env.SF_GATEWAY_BASE_URL;t=createSkillSearchTools(props);assert.equal((await t.execute('salesforce','会社')).status,'unavailable');assert.equal(fetched.length,beforeMissing);process.env.SF_GATEWAY_BASE_URL='https://gateway.test';
 const stopped=new AbortController();stopped.abort();t=createSkillSearchTools({...props,signal:stopped.signal});assert.equal((await t.execute('salesforce','会社')).status,'error');assert.equal(fetched.length,beforeMissing);
 docIdentity=false;t=createSkillSearchTools(props);assert.equal((await t.execute('documents','規程')).status,'denied');assert.equal(docCalls.length,0);docIdentity=true;
 t=createSkillSearchTools(props);assert.equal((await t.execute('documents','規程')).status,'ok');assert.equal(docCalls.at(-1).userHash,'trusted-hash');assert.equal(docCalls.at(-1).deptLower,'sales');assert.ok(docCalls.at(-1).filter.includes('dept_common'));
 t=createSkillSearchTools({...props,userMessage:'フォルダー内の規程を検索'});assert.equal((await t.execute('documents','規程')).status,'needs_confirmation');
 configured=false;t=createSkillSearchTools(props);assert.equal((await t.execute('web','ニュース')).status,'unavailable');configured=true;
 webError='Brave Search returned HTTP 422: SUBSCRIPTION_TOKEN_INVALID private-upstream-body';t=createSkillSearchTools(props);
 const webDenied=await t.execute('web','ニュース');assert.equal(webDenied.status,'denied');assert.equal(webDenied.reason,'web_authentication_failed');assert.ok(!JSON.stringify(webDenied).includes('private-upstream-body'));
 webError=undefined;
 t=createSkillSearchTools(props);for(let i=0;i<8;i++)await t.execute('web','ニュース');assert.equal((await t.execute('web','ニュース')).status,'limit');
 assert.equal(sfQuery.hasInvalidCompanyFilter("SELECT Id FROM Account WHERE Name = 'None'"),true);
 assert.equal(sfQuery.hasInvalidCompanyFilter("SELECT Id FROM Account WHERE Account.Name LIKE '%undefined%'"),true);
 assert.equal(sfQuery.hasInvalidCompanyFilter("SELECT Id FROM Account WHERE Name = '実会社'"),false);
 assert.equal(sfQuery.companyForLookup('Skill「取引先情報」を使って、J&T環境株式会社への訪問準備'),'J&T環境株式会社');
 assert.equal(sfQuery.companyForLookup('ミダック株式会社を検索','別会社株式会社'),'ミダック株式会社');
 assert.equal(sfQuery.buildAccountCandidateQuery('Ｊ＆Ｔ環境㈱'),'取引先名にJ&T環境を含む取引先を検索して');
 assert.equal(sfQuery.matchesCompanyName('Ｊ&Ｔ環境株式会社 川崎工場','J&T環境株式会社'),true);
 const linkedRecord={Name:'J&T環境株式会社',OwnerName:'検証担当',lightning_url:'https://example--fullsand.sandbox.lightning.force.com/lightning/r/Account/001000000000001AAA/view'};
 assert.equal(sfQuery.withSalesforceRecordId(linkedRecord,'Account').Id,'001000000000001AAA');
 assert.equal(sfQuery.withSalesforceRecordId({...linkedRecord,lightning_url:linkedRecord.lightning_url.replace('example--fullsand.sandbox.lightning.force.com','attacker.test')},'Account').Id,undefined);
 assert.equal(sfQuery.withSalesforceRecordId(linkedRecord,'Opportunity').Id,undefined);
 assert.equal(sfQuery.sameSalesforceId('001000000000001','001000000000001AAA'),true);
 const companyProps={...props,userMessage:'J&T環境株式会社の訪問準備'};
 const invalid={ok:true,object:'Account',items:[],soql:"SELECT Id FROM Account WHERE Name = 'None'",total_count:0};
 const candidates={ok:true,object:'Account',items:[{Id:'001a',Name:'Ｊ＆Ｔ環境株式会社'},{Id:'001b',Name:'J&T環境株式会社 川崎工場'}],total_count:2};
 let countBefore=fetched.length;fetchQueue=[invalid,candidates];t=createSkillSearchTools(companyProps);
 let recovered=await t.execute('salesforce','取引先のJ&T環境株式会社について教えて','J&T環境株式会社');
 assert.equal(recovered.status,'needs_confirmation');assert.equal(recovered.data.length,2);assert.equal(fetched.length,countBefore+2);
 assert.equal(fetched.at(-1).url.searchParams.get('q'),'取引先名にJ&T環境を含む取引先を検索して');
 fetchQueue=[invalid,invalid];t=createSkillSearchTools(companyProps);assert.equal((await t.execute('salesforce','取引先のJ&T環境株式会社を検索')).status,'error');
 fetchQueue=[invalid];t=createSkillSearchTools(props);assert.equal((await t.execute('salesforce','取引先を検索')).status,'error');
 countBefore=fetched.length;fetchQueue=[invalid];t=createSkillSearchTools(companyProps);assert.equal((await t.execute('salesforce','私の取引先のJ&T環境株式会社を検索')).status,'error');assert.equal(fetched.length,countBefore+1);
 fetchQueue=[{ok:true,object:'Account',items:[],total_count:0},candidates];t=createSkillSearchTools(companyProps);assert.equal((await t.execute('salesforce','J&T環境株式会社の取引先を検索')).status,'needs_confirmation');
 fetchQueue=[{ok:true,object:'Account',items:[],total_count:0},{ok:true,object:'Account',items:[],total_count:0}];t=createSkillSearchTools(companyProps);assert.equal((await t.execute('salesforce','J&T環境株式会社の取引先を検索')).status,'empty');
 fetchQueue=[{ok:true,object:'Account',items:[{Name:'別の会社株式会社'}],total_count:1}];t=createSkillSearchTools(companyProps);assert.equal((await t.execute('salesforce','J&T環境株式会社の取引先を検索')).status,'error');
 fetchQueue=[{ok:true,object:'Account',items:[{Id:'001a',Name:'J&T環境株式会社'},{Id:'001b',Name:'別の会社株式会社'}],total_count:2}];t=createSkillSearchTools(companyProps);
 const partialAccounts=await t.execute('salesforce','J&T環境株式会社の取引先を検索');assert.equal(partialAccounts.status,'ok');assert.equal(partialAccounts.excludedCount,1);assert.equal(partialAccounts.truncated,true);
 fetchQueue=[{ok:true,object:'Opportunity',items:[{Id:'006a',AccountId:'001a'},{Id:'006b'},{Id:'006c',AccountId:'001b'}],total_count:100}];t=createSkillSearchTools({...companyProps,selectedAccount:{id:'001a',name:'J&T環境株式会社'}});
 const partialOpportunities=await t.execute('salesforce','選択先の商談を取得');assert.equal(partialOpportunities.status,'ok');assert.equal(partialOpportunities.excludedCount,2);assert.deepEqual(partialOpportunities.data.map(i=>i.Id),['006a']);assert.equal(partialOpportunities.reason,'partial_verified_results');
 fetchQueue=[candidates];t=createSkillSearchTools({...companyProps,selectedAccount:{id:'001a',name:'Ｊ＆Ｔ環境株式会社'}});const chosen=await t.execute('salesforce','J&T環境株式会社の取引先を検索');assert.equal(chosen.status,'ok');assert.deepEqual(chosen.data.map(i=>i.Id),['001a']);
 fetchQueue=[{ok:true,object:'Opportunity',items:[{Id:'006a',Name:'同名の別拠点商談'}]}];t=createSkillSearchTools({...companyProps,selectedAccount:{id:'001a',name:'Ｊ＆Ｔ環境株式会社'}});assert.equal((await t.execute('salesforce','J&T環境株式会社の商談を検索')).status,'error');
 const choiceHistory=[{role:'user',content:'Skill「訪問準備」を使って、J&T環境株式会社を調べて'},{role:'assistant',content:'対象を選択してください。\n1. J&T環境株式会社 — [Salesforceで確認](https://example.sandbox.lightning.force.com/lightning/r/Account/001RA00000rKdLGYA0/view)\n参照したSkill: 訪問準備 v1'}];
 assert.equal(continuation.resolveSkillSearchChoice('1',choiceHistory).account.id,'001RA00000rKdLGYA0');
 assert.equal(continuation.resolveSkillSearchChoice('1番でお願いします',choiceHistory).skillName,'訪問準備');
 const publicSelection={role:'tool',content:JSON.stringify({integration:'skill_search_selection',observedAt:new Date().toISOString(),skillName:'訪問準備',skillId:'shared-'+'a'.repeat(32),skillVersion:7,originalRequest:choiceHistory[0].content})};
 const publicChoice=continuation.resolveSkillSearchChoice('1',choiceHistory,[publicSelection]);
 assert.equal(publicChoice.skillId,'shared-'+'a'.repeat(32));assert.equal(publicChoice.skillVersion,7);
 assert.equal(continuation.readSkillSelectionSnapshot([{...publicSelection,role:'user'}],'訪問準備',choiceHistory[0].content),undefined,'user messages cannot choose an execution ID for continuation');
 const expiredSelection=continuation.readSkillSelectionSnapshot([publicSelection],'訪問準備',choiceHistory[0].content,Date.now()+700000);
 assert.equal(expiredSelection.skillId,publicChoice.skillId);assert.equal(expiredSelection.skillVersion,undefined,'expired selection keeps its ID but fails execution version validation; never falls back by name');
 assert.equal(continuation.isSkillSearchChoiceReply('７で'),true);
 for(const reply of ['では８で','それでは、８番で','じゃあ ８番でお願いします'])assert.equal(continuation.isSkillSearchChoiceReply(reply),true);
 assert.equal(continuation.isSkillSearchChoiceReply('では8時で'),false);
 assert.equal(continuation.resolveSkillSearchChoice('では１で',choiceHistory).account.id,'001RA00000rKdLGYA0');
 assert.equal(continuation.resolveSkillSearchChoice('１で',choiceHistory).account.id,'001RA00000rKdLGYA0');
 assert.equal(continuation.resolveSkillSearchChoice('７で',choiceHistory),undefined);
 assert.equal(continuation.resolveSkillSearchChoice('2',choiceHistory),undefined);
 assert.equal(continuation.resolveSkillSearchChoice('別の話題を調べて',choiceHistory),undefined);
 assert.equal(continuation.resolveSkillSearchChoice('1',[{role:'assistant',content:'通常の回答'}]),undefined);
 const snap={integration:'skill_search_account_candidates',observedAt:new Date().toISOString(),records:[{Id:'001a',Name:'Ｊ＆Ｔ環境株式会社',Industry:'製造業'}]};
 const fiscalState={integration:'skill_search_fiscal_pending',observedAt:new Date().toISOString(),skillName:'訪問準備',account:{id:'001RA00000rKdLGYA0',name:'J&T環境株式会社'},originalRequest:'Skill「訪問準備」で調べて'};
 const pendingMessages=[{role:'assistant',content:'会計年度を教えてください。\n参照したSkill: 訪問準備 v1'},{role:'tool',content:JSON.stringify(fiscalState)}];
 assert.equal(continuation.resolveSkillSearchPeriod('2025年4月～2026年3月',pendingMessages).account.id,fiscalState.account.id);
 assert.equal(continuation.resolveSkillSearchPeriod('2025年4月～2026年3月',pendingMessages.map(m=>({...m,role:'user'}))),undefined);
 assert.equal(continuation.resolveSkillSearchPeriod('2025年4月～2026年3月',pendingMessages,Date.now()+700000),undefined);
 assert.equal(continuation.resolveSkillSearchPeriod('2025年4月～2026年3月',[{role:'assistant',content:'別の回答'},pendingMessages[1]]),undefined);
 assert.equal(continuation.resolveSkillSearchPeriod('今期の上期は？',[pendingMessages[0],{role:'tool',content:JSON.stringify({...fiscalState,integration:'skill_search_fiscal_complete'})}]).account.id,fiscalState.account.id);
 assert.equal(continuation.readSelectedAccountSnapshot([{role:'tool',content:JSON.stringify(snap)}],'001a').Industry,'製造業');
 assert.equal(continuation.readSelectedAccountSnapshot([{role:'user',content:JSON.stringify(snap)}],'001a'),undefined);
 assert.equal(continuation.readSelectedAccountSnapshot([{role:'tool',content:JSON.stringify({...snap,observedAt:'2020-01-01'})}],'001a'),undefined);
 assert.equal(continuation.readSelectedAccountSnapshot([{role:'tool',content:JSON.stringify({...snap,records:[linkedRecord]})}],'001000000000001AAA').OwnerName,'検証担当');
 t=createSkillSearchTools({...companyProps,selectedAccount:{id:'001a',name:'Ｊ＆Ｔ環境株式会社'},selectedAccountRecord:snap.records[0]});countBefore=fetched.length;
 assert.equal((await t.execute('salesforce','取引先の基本情報を取得')).data[0].Industry,'製造業');assert.equal(fetched.length,countBefore);
 allowed=false;assert.equal((await t.execute('salesforce','取引先の基本情報を取得')).status,'denied');allowed=true;
 const displayCandidates={...candidates,items:candidates.items.map((item,i)=>({...item,Id:'001'+String(i+1).padStart(12,'0'),lightning_url:'https://example.sandbox.lightning.force.com/lightning/r/Account/001'+String(i+1).padStart(12,'0')+'/view'}))};
 fetchQueue=[invalid,displayCandidates];plan=[toolCall('salesforce'),toolCall('web',2)];planning=[];finals=[];
 const directChoice=await runSkillSearch({chatThread:{id:'thread-1'},skills:[{title:'訪問準備',content:'会社を調べる',version:1}],message:'J&T環境株式会社の取引先を検索',history:[],email:'user@test',signal:props.signal});
 assert.equal(planning.length,1,'candidate ambiguity stops further automatic searches');
 assert.equal(finals.length,0,'candidate lists must bypass generated final answers');
 assert.ok(directChoice.directContent.includes(displayCandidates.items[1].Id));
 plan=[];finals=[];
 await runSkillSearch({chatThread:{id:'thread-1'},skills:[{title:'訪問準備',content:'会社を調べる',version:1}],message:'1',originalRequest:'J&T環境株式会社の取引先を検索',selectedAccount:{id:'001a',name:'Ｊ＆Ｔ環境株式会社'},selectedAccountRecord:snap.records[0],history:[],email:'user@test',signal:props.signal});
 assert.ok(finals[0].messages[0].content.includes('製造業'),'selected server snapshot grounds the planning model');
 assert.ok(finals[0].messages.at(-1).content.includes('製造業'),'a later lookup failure cannot erase already obtained Account facts');
 fetchQueue=[displayCandidates];plan=[];planning=[];finals=[];
 const preflightChoice=await runSkillSearch({chatThread:{id:'thread-1'},skills:[{title:'訪問準備',content:'Salesforceを検索',version:1}],message:'J&T環境株式会社を調べて',history:[],email:'user@test',signal:props.signal});
 assert.equal(planning.length,0,'company discovery and ambiguity handling happen before free-form model planning');
 assert.ok(preflightChoice.directContent.includes('対象のSalesforce取引先'));
 const formatter=load('features/skills/execution/skill-account-candidates.ts');
 const rows=Array.from({length:28},(_,i)=>({Id:'001'+String(i+1).padStart(12,'0'),Name:'J&T環境株式会社 部署'+(i+1),lightning_url:'https://example.sandbox.lightning.force.com/lightning/r/Account/001'+String(i+1).padStart(12,'0')+'/view',OwnerName:'社内担当',BillingCity:'川崎市'}));
 const full=formatter.formatAccountCandidates({status:'needs_confirmation',data:rows},'参照したSkill: 訪問準備 v1');
 assert.equal((full.match(/^\| \d+ \|/gm)||[]).length,28,'never collapse candidates into an Other group');
 assert.equal(continuation.resolveSkillSearchChoice('７で',[choiceHistory[0],{role:'assistant',content:full}]).account.id,rows[6].Id);
 assert.equal(continuation.resolveSkillSearchChoice('では８で',[choiceHistory[0],{role:'assistant',content:full}]).account.id,rows[7].Id);
 assert.ok(full.includes('川崎市'));assert.ok(full.includes('今回の一覧内だけ'));
 assert.ok(full.includes('| 取引先 | 請求先住所 | 社内担当営業 |'));
 assert.ok(full.includes('社内担当'));assert.ok(!full.includes('取引先責任者'));
 assert.ok(formatter.formatAccountCandidates({status:'needs_confirmation',data:[{...rows[0],Name:'会社|部署',OwnerName:'担当\n営業|A',BillingPostalCode:'212-0013',BillingStreet:'住所\n2階'}]},'').includes('会社\\|部署'));
 assert.throws(()=>formatter.formatAccountCandidates({status:'needs_confirmation',data:[{...rows[0],lightning_url:'https://attacker.test/lightning/r/Account/'+rows[0].Id+'/view'}]},''));
 fetchQueue=[];plan=[];planning=[];finals=[];countBefore=fetched.length;
 await runSkillSearch({chatThread:{id:'thread-1'},skills:[{title:'訪問準備',content:'Salesforceを検索',version:1}],message:'J&T環境株式会社をWeb検索のみで調べて',history:[],email:'user@test',signal:props.signal});
 assert.equal(fetched.length,countBefore,'Web-only requests do not prefetch Salesforce');
 process.env.SF_SKILL_READ_BASE_URL='http://127.0.0.1:8003';process.env.SF_SKILL_READ_KEY='local-read-secret-do-not-log';
 fetchQueue=[{ok:true,contract:'sf-skill-read-v1',object:'Opportunity',items:[{Id:'006a',Name:'商談',AccountId:'001a',Amount:100,CloseDate:'2026-10-31'}]}];
 t=createSkillSearchTools({...companyProps,selectedAccount:{id:'001a',name:'Ｊ＆Ｔ環境株式会社'}});
 assert.equal((await t.execute('salesforce','選択先の商談を取得','J&T環境株式会社','opportunities')).status,'ok');
 const typed=fetched.at(-1);assert.equal(typed.url.pathname,'/api/skills/salesforce/search');assert.equal(typed.options.method,'POST');
 assert.deepEqual(JSON.parse(typed.options.body),{operation:'opportunities',company:'J&T環境株式会社',accountId:'001a'});
 assert.equal(typed.url.searchParams.has('q'),false);assert.equal(typed.options.headers['X-User-Email'],'user@test');
 fetchQueue=[{ok:true,object:'SalesSummary',items:[{Billing__c:'001a',isBillingAccount:true,fiscalTotalAmount:12345}]}];
 t=createSkillSearchTools({...companyProps,selectedAccount:{id:'001a',name:'J&T環境株式会社'},fiscalPeriod:{fiscalStart:'2025-04-01',fiscalEnd:'2026-04-01'}});
 assert.equal((await t.execute('salesforce','売上集計',undefined,'sales')).status,'ok');
 assert.equal(JSON.parse(fetched.at(-1).options.body).fiscalStart,'2025-04-01');
 fetchQueue=[{ok:true,object:'SalesSummary',items:[{Billing__c:'different-account',fiscalTotalAmount:99999}]}];
 t=createSkillSearchTools({...companyProps,selectedAccount:{id:'001a',name:'J&T環境株式会社'}});
 assert.equal((await t.execute('salesforce','売上集計',undefined,'sales')).status,'error');
 const diagnostic=[];const originalInfo=console.info;console.info=(...args)=>diagnostic.push(args);
 try{fetchMode='throw';t=createSkillSearchTools(props);assert.equal((await t.execute('salesforce','会社')).status,'error');}finally{console.info=originalInfo;fetchMode='ok';}
 const logged=diagnostic.find(([name])=>name==='[skill-search] result')[1];assert.equal(logged.gateway,'typed_local');assert.ok(logged.reason);assert.equal(typeof logged.elapsedMs,'number');assert.ok(!JSON.stringify(diagnostic).includes('private secret'));assert.ok(!JSON.stringify(diagnostic).includes('local-read-secret-do-not-log'));
 fetchQueue=[{ok:true,object:'Opportunity',items:[{Id:'006a',AccountId:'001a',Amount:100}]},{ok:true,object:'Activity',items:[{Id:'00Ua',AccountId:'001a',ActivityDate:'2026-03-01'}]},{ok:true,object:'SalesSummary',items:[{Billing__c:'001a',isBillingAccount:true,fiscalTotalAmount:12345}]}];
 plan=[];finals=[];const beforeRequirements=fetched.length;
 await runSkillSearch({chatThread:{id:'thread-1'},skills:[{title:'訪問準備',content:requiredSkills[0].content,version:1}],message:'７で',originalRequest:'J&T環境株式会社を調べて。前会計年度は2025年4月～2026年3月です',selectedAccount:{id:'001a',name:'J&T環境株式会社'},selectedAccountRecord:snap.records[0],history:[],email:'user@test',signal:props.signal});
 assert.deepEqual(fetched.slice(beforeRequirements).map(r=>JSON.parse(r.options.body).operation),['opportunities','activities','sales'],'required searches execute even when the planning model asks for no tools');
 assert.ok(finals[0].messages[0].content.includes('Markdown表'));
 assert.ok(finals[0].messages.some(m=>typeof m.content==='string'&&m.content.includes('12345')));
 fetchQueue=[{ok:true,object:'SalesSummary',items:[{Billing__c:'001a',isBillingAccount:true,fiscalTotalAmount:4321}]}];
 plan=[];finals=[];
 await runSkillSearch({chatThread:{id:'thread-1'},skills:[{title:'売上確認',content:'Salesforce Sales__cの売上を確認',version:1}],message:'今期の上期は？',originalRequest:'J&T環境株式会社。2025年4月～2026年3月の売上を確認',selectedAccount:{id:'001a',name:'J&T環境株式会社'},selectedAccountRecord:snap.records[0],history:[],email:'user@test',signal:props.signal});
 assert.deepEqual({fiscalStart:JSON.parse(fetched.at(-1).options.body).fiscalStart,fiscalEnd:JSON.parse(fetched.at(-1).options.body).fiscalEnd},requirements.readFiscalPeriod('今期の上期'),'latest user period overrides the earlier request period');
 delete process.env.SF_SKILL_READ_BASE_URL;delete process.env.SF_SKILL_READ_KEY;
 console.log('PASS Salesforce None-filter recovery, normalized company lookup, ambiguous candidates, valid zero results, and no silent owner-scope widening');
 const cases=[['取引先情報',['salesforce','salesforce','web']],['営業進捗管理',['salesforce','salesforce']],['商談促進',['salesforce','web','documents']],['週ミーティング',['salesforce','documents']],['社内ルール博士',['documents']],['社内システム博士',['documents']],['訪問前ブリーフィング',['salesforce','web','documents']]];
 for(const [title,sources] of cases){
  await new Promise(resolve=>setImmediate(resolve));
  plan=sources.map((s,i)=>toolCall(s,i));planning=[];finals=[];
  const execution=await runSkillSearch({chatThread:{id:'thread-1'},skills:[{id:title,title,content:'必要なデータを検索し、出典と不足を明記する。',version:1,enabled:true}],message:'Skill「'+title+'」を使って、検証会社について調べて',history:[],email:'user@test',signal:props.signal});
  if(sources.includes('documents'))assert.ok(execution.citationResults.some(s=>s.includes('citation-1')));
  const result=finals[0];assert.ok(result);assert.equal(result.tools,undefined);
  const results=result.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));assert.deepEqual(results.map(r=>r.source),sources);assert.ok(results.every(r=>r.status==='ok'));
  assert.deepEqual(planning[0].tools.map(t=>t.function.name),['skill_search_salesforce','skill_search_web','skill_search_documents']);
  assert.ok(result.messages[0].content.includes(title));assert.ok(result.messages.at(-1).content.includes('実行記録'));
  console.log('PASS representative Skill (mock model/data): '+title);
 }
 plan=Array.from({length:12},(_,i)=>toolCall('web',i));planning=[];await runSkillSearch({chatThread:{id:'thread-1'},skills:[{title:'上限',content:'検索',version:1}],message:'検索',history:[],email:'user@test',signal:props.signal});assert.equal(planning.length,6);
 const source=fs.readFileSync(path.resolve(__dirname,'../features/chat-page/chat-services/chat-api/chat-api.ts'),'utf8');assert.ok(source.includes('if (shouldRunSkillSearch(selectedSkills.length))'));assert.ok(source.includes('salesforceRouting,'));
 fetchQueue=[{ok:true,object:'Account',items:[],count:0,total_count:47846,aggregation_result:{func:'COUNT',value:47846,source:'soql_count',scope:'all'},resolved_fields:[{label:'請求先',api_name:'BillingFlag__c'}],context_applied:{applied:true}}];
 const exactCount=await createSkillSearchTools({...props,userMessage:'取引先の件数'}).execute('salesforce','取引先の件数');
 assert.equal(exactCount.status,'ok');assert.ok(exactCount.authoritativeText.includes('47,846'));assert.ok(exactCount.message.includes('resolved_fields'));assert.ok(exactCount.message.includes('context_applied'));
 fetchQueue=[{ok:true,status:'needs_account_selection',items:[],account_candidates:[{id:'001000000000001AAA',name:'会社A',lightning_url:'https://test.sandbox.lightning.force.com/lightning/r/Account/001000000000001AAA/view'}],zero_reason:'account_ambiguous'}];
 const ambiguous=await createSkillSearchTools({...props,userMessage:'取引先の件数'}).execute('salesforce','取引先の件数');
 assert.equal(ambiguous.status,'needs_confirmation');assert.ok(ambiguous.message.includes('account_ambiguous'));
 fetchQueue=[{ok:true,object:'Account',items:[],aggregation_result:{func:'COUNT',value:6530,scope:'all',source:'soql_count'}}];
 plan=[{role:'assistant',content:null,tool_calls:[{id:'count',type:'function',function:{name:'skill_search_salesforce',arguments:JSON.stringify({query:'取引先の件数'})}}]}];finals=[];
 const direct=await runSkillSearch({chatThread:{id:'thread-1'},skills:[{title:'件数確認',content:'Salesforceの件数を確認',version:1}],message:'取引先の件数',history:[],email:'user@test',signal:props.signal});
 assert.ok(direct.directContent.includes('6,530'));assert.equal(finals.length,0,'authoritative count must bypass final summary LLM');
 console.log('PASS policy, ACL, gateway failures, candidates, authoritative COUNT without final LLM, metadata, citations and bounds');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
