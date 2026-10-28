const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {createHash} = require('node:crypto');
const {EventEmitter} = require('node:events');
const principal = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
const actor = {email:'owner@example.test',salesforcePrincipal:principal};
let currentActor = actor, allowed = true, fetches = [], mode='ok', planning=[], planned=[], catalog=[], issueQueue=[];
const stubs = {
  'server-only':{},
  '@/features/canvas/canvas-actor':{getCanvasActor:async()=>currentActor,withCanvasActor:(_actor,fn)=>fn()},
  '@/features/skills/skill-service':{listActorSkills:async()=>catalog},
  './teams-search-service':{},
  '@/features/common/services/salesforce-access':{isSalesforceAllowedEmail:()=>allowed},
  './salesforce-access':{isSalesforceAllowedEmail:()=>allowed},
  '@/features/common/services/salesforce-routing':{buildSalesforceGatewayQuery:q=>q},
  '@/features/chat-page/chat-services/azure-ai-search/azure-ai-search':{},
  '@/features/chat-page/chat-services/chat-api/chat-api-rag':{},
  '@/features/chat-page/chat-services/citation-service':{},
  '@/features/teams/teams-brave-search-service':{isTeamsBraveSearchConfigured:()=>false},
  '@/features/common/services/openai': {OpenAIInstance: () => ({
    chat: {completions: {create: async p => {planning.push(p); return {choices:[{message:planned.shift() ?? {role:'assistant',content:'ready'}}]};}}},
    beta: {chat: {completions: {stream: () => {const e = new EventEmitter(); e.finalChatCompletion=async()=>({choices:[{message:{content:'取得できた営業進捗。期間が必要な分析は未取得。'}}]});setImmediate(()=>e.emit('end'));return e;}}}},
  })},
};
const cache = new Map();
function load(file) {
  file=path.resolve(__dirname,'..',file);if(cache.has(file))return cache.get(file);
  const module={exports:{}};
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',js)(id=>{
    if(Object.hasOwn(stubs,id))return stubs[id];
    if(id.startsWith('.'))return load(path.resolve(path.dirname(file),id+'.ts'));
    if(id.startsWith('@/'))return load(id.slice(2)+'.ts');return require(id);
  },module,module.exports);cache.set(file,module.exports);return module.exports;
}
Object.assign(process.env,{SF_PERSONAL_MODE:'true',SF_PERSONAL_SCOPE:'whitelist',SF_PERSONAL_SNAPSHOT_POLICY:'strict',SF_PERSONAL_AUTH_METHOD:'oauth',SF_PERSONAL_SIGNING_KEY:'test-key-'.repeat(8),SF_PERSONAL_GATEWAY_BASE_URL:'https://personal.test',SF_GATEWAY_BASE_URL:'https://shared.test',SF_SKILL_READ_BASE_URL:'https://legacy.test',SF_PERSONAL_USERS_JSON:JSON.stringify([actor.principal?actor:{principal,email:actor.email}])});
global.fetch=async(url,options)=>{
  const target=new URL(url);fetches.push({target,options});
  if(issueQueue.length) {
    const {body,status}=issueQueue.shift();
    return Response.json(body,{status,headers:{'X-SF-Connection-Mode':'personal-oauth','X-AC-Principal':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
  }
  if(mode==='invalid-company')return Response.json({ok:false,error:'invalid_company'},{status:400});
  if(mode==='context-missing-422' || mode==='context-missing-200')return Response.json({ok:false,error:'context_missing',error_kind:'context_missing',needs_clarification:true,message:'引き継ぐ件数検索の条件がありません。対象と条件を含めて質問してください。'},{status:mode==='context-missing-422'?422:200,headers:{'X-SF-Connection-Mode':'personal-oauth','X-AC-Principal':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
  const q=target.searchParams.get('q') || '';
  const payload=options.body ? JSON.parse(options.body) : undefined;
  const operation=payload?.planVersion==='SF_READ_PLAN_V2' ? ({Account:'accounts',Opportunity:'opportunities',Activity:'activities'})[payload.plan.object] : payload ? payload.operation : /件数/.test(q) ? 'count' : /商談|opportunities/.test(q) ? 'opportunities' : /活動|activities/.test(q) ? 'activities' : 'accounts';
  const records=operation==='accounts'?[{Id:'001000000000001AAA',Name:'Example',lightning_url:'https://sf.test/account'}]:[];
  return new Response(JSON.stringify({ok:mode!=='denied',plan_version:payload?.planVersion,object:mode==='wrong-object'?'Contact':operation==='accounts' || operation==='count' ?'Account':operation==='activities'?'Activity':operation==='sales'?'SalesSummary':'Opportunity',items:records,snapshot_proof:mode==='no-proof' || operation==='count' ?null:'proof-for-'+operation,...(operation==='count'?{aggregation_result:{func:'COUNT',value:7,source:'soql_count',scope:'all'}}:{})}),{status:mode==='denied'?403:200,headers:{'X-SF-Connection-Mode':'personal-oauth','X-AC-Principal':mode==='wrong-person'?'foreign':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
};
const {createSkillSearchTools}=load('features/skills/execution/skill-search-tools.ts');
const {mergeSkillSnapshots}=load('features/skills/execution/skill-personal-access.ts');
const {runSkillSearch}=load('features/skills/execution/skill-search-runner.ts');
const {resolveSkillSalesforceScope,buildSkillSalesforceQuery,gatewayWantsReadPlan}=load('features/skills/execution/skill-salesforce-scope.ts');
const {proofGatewayThread}=load('features/common/services/salesforce-proof-thread.ts');
const continuationPattern=/そのうち|その中で|検索.*(?:くれた|した|対象|条件)|(?:先ほど|さっき|直前).*(?:条件|対象|範囲)/;
for(const target of [undefined,'accounts','opportunities','activities','contacts','sales','count'])
  for(const company of [undefined,'Example株式会社'])
    for(const owner of [undefined,'黄'])
      for(const period of [undefined,'今期',{start:'2026-04-01',end:'2027-04-01'}]) {
        const q=buildSkillSalesforceQuery('黄さんが担当する取引先を検索',{target,company,owner,period});
        assert.equal(continuationPattern.test(q),false,q);
        assert.ok(q.startsWith('黄さんが担当する取引先を検索'));
        if(target)assert.ok(q.includes('種類: '));
        if(target!=='count')for(const hasContext of [false,true])assert.equal(gatewayWantsReadPlan(q,hasContext),false,JSON.stringify({q,hasContext}));
      }
for(const query of ['取引先の数ではなく一覧','複数の取引先を取得','さっきの検索条件で取引先を検索','その中で取引先を取得','取引先を集計','取引先を検索した対象'])assert.throws(()=>buildSkillSalesforceQuery(query,{target:'accounts'}),/独立した取得依頼/);
for(const query of ['Accountの一覧','先ほどの取引先','直前の取引先','数研株式会社の商談','そのうち商談を取得','数量と数値を含む活動','複数の商談を取得']) {
  for(const hasContext of [false,true])assert.equal(gatewayWantsReadPlan(query,hasContext),false,query);
  assert.ok(buildSkillSalesforceQuery(query,{}).startsWith(query));
}
assert.equal(gatewayWantsReadPlan('その中で取引先を取得',false),false);
assert.equal(gatewayWantsReadPlan('その中で取引先を取得',true),true);
assert.equal(gatewayWantsReadPlan('ありがとう',false),true);
assert.equal(gatewayWantsReadPlan('count Account',false),true);
assert.throws(()=>buildSkillSalesforceQuery('取引先を取得',{target:'accounts',company:'数研株式会社'}),/固有名詞/,'Do not silently alter literal company names to evade routing');
assert.ok(buildSkillSalesforceQuery('取引先の件数',{target:'count'}).includes('件数'));
assert.equal(resolveSkillSalesforceScope(undefined,'A社様の商談').owner,undefined);
assert.equal(resolveSkillSalesforceScope(undefined,'お客様の声').owner,undefined);
assert.equal(resolveSkillSalesforceScope(undefined,'A社さんの商談').owner,undefined);
assert.equal(resolveSkillSalesforceScope(undefined,'営業部の黄さんの商談').owner,'黄');
assert.equal(resolveSkillSalesforceScope({owner:'存在しない担当者'},'トヨタの商談').owner,undefined);
assert.equal(resolveSkillSalesforceScope({owner:'渡部'},'営業部の渡部さんの商談').owner,'渡部','Explicit names with 部 remain valid when evidenced in the request');
assert.equal(process.env.SF_PERSONAL_MODE,'true');
assert.equal(load('features/common/services/salesforce-personal.ts').personalSalesforceForEmail(actor.email),true);
const props={email:actor.email,threadId:'owned-thread',userMessage:'Exampleを訪問したい',signal:new AbortController().signal};
(async()=>{
  const tool=createSkillSearchTools(props);
  assert.equal((await tool.execute('salesforce','Exampleの取引先を検索','Example','accounts')).status,'ok');
  assert.equal(fetches[0].target.origin,'https://personal.test');
  assert.equal(fetches[0].target.pathname,'/api/sf/query_nl');
  assert.equal(fetches[0].options.headers['X-Skill-Read-Key'],undefined);
  const firstGatewayThread=fetches[0].options.headers['X-Chat-Thread-Id'];
  assert.notEqual(firstGatewayThread,'owned-thread');assert.equal(proofGatewayThread(Buffer.from(JSON.stringify({thread:firstGatewayThread})).toString('base64url')+'.signature','owned-thread'),firstGatewayThread);
  const claim=JSON.parse(Buffer.from(fetches[0].options.headers['X-AC-Identity'],'base64url'));
  assert.equal(claim.principal,principal);assert.equal(claim.method,'GET');
  assert.equal(claim.thread,firstGatewayThread);
  assert.equal(claim.body,createHash('sha256').update('').digest('hex'));
  assert.deepEqual(tool.salesforceSnapshot.proofs,['proof-for-accounts']);
  mode='no-proof';
  await tool.execute('salesforce','Exampleの取引先を検索','Example','accounts');
  assert.equal(fetches.at(-1).options.headers['X-Chat-Thread-Id'],firstGatewayThread,'One execution keeps its Gateway context for its related reads');
  assert.deepEqual(tool.salesforceSnapshot.proofs,[],'One missing proof must protect the entire saved answer');
  assert.deepEqual(mergeSkillSnapshots({orgId:'org',userId:'user',retrievedAt:'now',proof:'a'},{orgId:'org',userId:'other',retrievedAt:'now',proof:'b'}).proofs,[]);
  mode='wrong-person';
  const wrong=createSkillSearchTools(props);
  assert.equal((await wrong.execute('salesforce','取引先を検索','Example','accounts')).status,'error');
  assert.equal(wrong.salesforceSnapshot,undefined);
  mode='denied';
  const denied=createSkillSearchTools(props);
  assert.equal((await denied.execute('salesforce','取引先を検索','Example','accounts')).status,'denied');
  mode='ok'; currentActor={...actor,email:'other@example.test'};
  const count=fetches.length;
  const mismatchedIdentity=await createSkillSearchTools(props).execute('salesforce','取引先を検索','Example','accounts');
  assert.equal(mismatchedIdentity.status,'denied');assert.equal(mismatchedIdentity.reason,'identity_mismatch');
  assert.equal(fetches.length,count,'Identity mismatch must not use any shared fallback');
  currentActor=actor;
  currentActor={email:actor.email};
  const beforeMissingPrincipal=fetches.length;
  const missingPrincipal=await createSkillSearchTools(props).execute('salesforce','取引先を検索','Example','accounts');
  assert.equal(missingPrincipal.reason,'identity_unavailable');assert.equal(missingPrincipal.status,'denied');
  assert.ok(missingPrincipal.message.includes('Microsoft'));
  assert.equal(fetches.length,beforeMissingPrincipal,'Missing Microsoft principal must stop before HTTP, without shared fallback');
  currentActor=actor;
  process.env.SF_PERSONAL_SCOPE='pilot';
  const beforeMismatch=fetches.length;
  const mismatch=createSkillSearchTools({...props,email:'changed@example.test'});
  // A previously enrolled principal cannot turn into a shared request after an email change.
  await mismatch.execute('salesforce','取引先を検索','Example','accounts');
  assert.equal(fetches.length,beforeMismatch);
  process.env.SF_PERSONAL_SCOPE='whitelist';
  const counts=createSkillSearchTools(props);
  const countResult=await counts.execute('salesforce','取引先の件数を教えて');
  assert.ok(countResult.authoritativeText.includes('7'));
  assert.equal(fetches.at(-1).target.pathname,'/api/sf/query_nl');
  const countClaim=JSON.parse(Buffer.from(fetches.at(-1).options.headers['X-AC-Identity'],'base64url'));
  assert.equal(countClaim.method,'GET');assert.equal(countClaim.body,createHash('sha256').update('').digest('hex'));
  assert.deepEqual(counts.salesforceSnapshot.proofs,[],'Unverifiable aggregates remain protected on reload');
  const personTools=createSkillSearchTools({...props,userMessage:'Skill「営業進捗」を使って、黄さんの営業進捗をレポートにまとめて'});
  for(const operation of ['accounts','opportunities','activities']) {
    await personTools.execute('salesforce',operation==='accounts'?'担当営業の取引先を検索':'担当営業の'+operation,undefined,operation);
    const sent=fetches.at(-1);
    assert.equal(sent.target.pathname,'/api/sf/query_nl','Company-less employee searches must not use the fixed self-owner typed endpoint');
    assert.equal(sent.options.method,undefined);
    assert.ok(sent.target.searchParams.get('q').includes('社内担当営業: 黄'),'Preserve requested employee even when the tool query omits the name');
    assert.ok(sent.target.searchParams.get('q').startsWith('担当営業の'),'Individual search comes before report context');
    assert.ok(!sent.target.searchParams.get('q').includes('Skill「'));
    const signed=JSON.parse(Buffer.from(sent.options.headers['X-AC-Identity'],'base64url'));
    assert.equal(signed.method,'GET');assert.equal(signed.principal,principal);
    assert.equal(signed.target,sent.target.pathname+sent.target.search);
  }
  await personTools.execute('salesforce','黄さんの取引先','黄さん','accounts');
  assert.equal(fetches.at(-1).target.pathname,'/api/sf/query_nl','A person returned as companyName by the model must not become a company lookup');
  await createSkillSearchTools({...props,userMessage:'黄さんの担当するExample株式会社の商談'}).execute('salesforce','商談','Example株式会社','opportunities');
  assert.equal(fetches.at(-1).target.pathname,'/api/sf/query_nl','Do not discard the named owner even when a company is also specified');
  const beforePersonSales=fetches.length;
  const personSales=await personTools.execute('salesforce','黄さんの売上',undefined,'sales');
  assert.equal(personSales.reason,'account_required');assert.equal(fetches.length,beforePersonSales,'Do not send invalid typed sales or use unverified NL financial aggregation');
  mode='invalid-company';
  const invalid=await createSkillSearchTools(props).execute('salesforce','Exampleの取引先を検索','Example','accounts');
  assert.equal(invalid.reason,'invalid_company');assert.equal(invalid.httpStatus,400);
  mode='ok';
  const selected={id:'001000000000001AAA',name:'Example'};
  const runnerProps={chatThread:{id:'owned-thread'},email:actor.email,skills:[{id:'skill-'+'a'.repeat(64),title:'訪問準備',version:1,content:'Salesforce Account Opportunityを調べる',enabled:true}],message:'Skill「訪問準備」を使って、Exampleを訪問したい',originalRequest:'Exampleを訪問したい',history:[],signal:props.signal,selectedAccount:selected,selectedAccountRecord:{Id:selected.id,Name:'OLD SECRET SNAPSHOT'}};
  const start=fetches.length;
  const result=await runSkillSearch(runnerProps);
  assert.ok(fetches.length>start);
  assert.equal(fetches[start].target.pathname,'/api/sf/query_nl','Account recheck uses verified personal NL before related searches');
  assert.equal(fetches[start].target.searchParams.get('account_id'),selected.id);
  assert.ok(!JSON.stringify(planning).includes('OLD SECRET SNAPSHOT'));
  assert.ok(result.salesforceSnapshot.proofs.includes('proof-for-accounts'));
  assert.equal(fetches.length,start+1,'Personal runner must not prefetch generic opportunities that lose the requested filters');
  const autoStart=fetches.length;
  await runSkillSearch({...runnerProps,message:'Skill「訪問準備」を使って、Example株式会社を訪問したい',originalRequest:'Example株式会社を訪問したい',selectedAccount:undefined,selectedAccountRecord:undefined});
  assert.equal(fetches.length,autoStart,'Unconfirmed company does not force fixed preflight searches; the model plans the actual searches');
  const sfTool=planning.at(-1).tools.find(t=>t.function.name==='skill_search_salesforce');
  for(const field of ['company','owner','period','target'])assert.ok(sfTool.function.parameters.properties[field]);
  const toyota=createSkillSearchTools({...props,userMessage:'トヨタの今期の商談'});
  await toyota.execute('salesforce','商談一覧を検索',undefined,undefined,{company:'トヨタ',period:'今期',target:'opportunities'});
  let sent=fetches.at(-1),q=sent.target.searchParams.get('q');
  assert.equal(sent.target.pathname,'/api/sf/query_nl');assert.ok(q.startsWith('商談一覧を検索'));assert.ok(q.includes('会社: トヨタ'));assert.ok(q.includes('期間: 今期'));
  mode='wrong-object';
  const mismatchObject=await toyota.execute('salesforce','商談一覧を検索',undefined,undefined,{company:'トヨタ',period:'今期',target:'opportunities'});
  assert.equal(mismatchObject.reason,'unexpected_object');assert.equal(mismatchObject.status,'error','Contact rows must not be accepted as opportunity results');
  mode='ok';
  await toyota.execute('salesforce','商談一覧を検索',undefined,undefined,{company:'存在しない別会社',target:'opportunities'});
  assert.ok(!fetches.at(-1).target.searchParams.get('q').includes('存在しない別会社'));
  const selectedTools=createSkillSearchTools({...props,selectedAccount:selected});
  await selectedTools.execute('salesforce','商談一覧',undefined,undefined,{target:'opportunities'});
  sent=fetches.at(-1);assert.equal(sent.target.pathname,'/api/skills/salesforce/search');assert.equal(JSON.parse(sent.options.body).accountId,selected.id);
  await selectedTools.execute('salesforce','年度売上を集計',undefined,undefined,{target:'sales',period:{start:'2026-04-01',end:'2027-04-01'}});
  sent=fetches.at(-1);assert.equal(sent.target.pathname,'/api/skills/salesforce/search');assert.equal(JSON.parse(sent.options.body).operation,'sales');assert.equal(JSON.parse(sent.options.body).fiscalStart,'2026-04-01');
  const companySales=await createSkillSearchTools({...props,userMessage:'A社様の年度売上',selectedAccount:selected}).execute('salesforce','年度売上を集計',undefined,undefined,{target:'sales'});
  assert.equal(companySales.status,'empty','A company honorific must not be treated as an owner-scoped sales request');
  assert.equal(fetches.at(-1).target.pathname,'/api/skills/salesforce/search');
  await selectedTools.execute('salesforce','活動一覧',undefined,undefined,{target:'activities',period:{start:'2026-04-01',end:'2027-04-01'}});
  assert.equal(fetches.at(-1).target.pathname,'/api/sf/query_nl','Extra conditions must not disappear into fixed queries');
  const long=createSkillSearchTools({...props,userMessage:'黄さんの今期の商談'+ 'あ'.repeat(5000)});
  await long.execute('salesforce','商談一覧を検索'+ '詳'.repeat(580),undefined,undefined,{owner:'黄',period:'今期',target:'opportunities'});
  sent=fetches.at(-1);q=sent.target.searchParams.get('q');assert.ok(q.length<=500);assert.ok(q.startsWith('商談一覧を検索'));assert.ok(q.includes('社内担当営業: 黄'));assert.ok(q.includes('期間: 今期'));
  const signed=JSON.parse(Buffer.from(sent.options.headers['X-AC-Identity'],'base64url'));
  assert.ok(sent.options.headers['X-AC-Identity'].length<=3000,'Percent-encoded Japanese must fit the Gateway identity limit');
  assert.equal(signed.target,sent.target.pathname+sent.target.search);
  const {createHmac}=require('node:crypto');assert.equal(sent.options.headers['X-AC-Signature'],createHmac('sha256',process.env.SF_PERSONAL_SIGNING_KEY).update(sent.options.headers['X-AC-Identity']).digest('hex'));
  const badBefore=fetches.length;
  assert.equal((await toyota.execute('salesforce','商談一覧',undefined,undefined,{owner:123})).status,'error');assert.equal(fetches.length,badBefore);
  const forwardStart=fetches.length;
  planned=[{role:'assistant',content:null,tool_calls:[{id:'call-scope',type:'function',function:{name:'skill_search_salesforce',arguments:JSON.stringify({query:'商談一覧を検索',company:'トヨタ',owner:'黄',period:'今期',target:'opportunities'})}}]}];
  await runSkillSearch({...runnerProps,message:'黄さんの担当するトヨタの今期の商談',originalRequest:'黄さんの担当するトヨタの今期の商談',selectedAccount:undefined,selectedAccountRecord:undefined});
  assert.equal(fetches.length,forwardStart+1);q=fetches.at(-1).target.searchParams.get('q');assert.ok(q.includes('会社: トヨタ') && q.includes('社内担当営業: 黄') && q.includes('期間: 今期'));
  for(const failureMode of ['context-missing-422','context-missing-200']) {
    mode=failureMode;
    const failedSearch=await createSkillSearchTools(props).execute('salesforce','取引先を検索',undefined,undefined,{target:'accounts'});
    assert.equal(failedSearch.status,'error');assert.equal(failedSearch.reason,'context_missing');assert.equal(failedSearch.authoritativeText,undefined);
    planning=[];
    const before=fetches.length;
    const call=(id,query,target)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:'skill_search_salesforce',arguments:JSON.stringify({query,target})}}]});
    planned=[call('failed-account','取引先を検索','accounts'),call('next-opportunity','商談を検索','opportunities')];
    const continued=await runSkillSearch({...runnerProps,message:'黄さんの営業進捗をまとめて',originalRequest:'黄さんの営業進捗をまとめて',selectedAccount:undefined,selectedAccountRecord:undefined});
    assert.equal(continued.directContent,undefined,'Gateway clarification must not become the final one-line answer');
    assert.ok(continued.runner,'Final report generation must still run');
    assert.equal(fetches.length,before+2,'Searches after context_missing must execute');
    const toolResult=planning.at(-1).messages.find(m=>m.role==='tool' && m.tool_call_id==='failed-account');
    assert.equal(JSON.parse(toolResult.content).status,'error');
    assert.equal(JSON.parse(toolResult.content).authoritativeText,undefined);
  }
  mode='ok';
  for(const status of [200,422])for(const reason of ['context_missing','unsupported_condition','invalid_structure','context_conflict',undefined]) {
    const body={ok:false,needs_clarification:true,...(reason?{error:reason,error_kind:reason}:{}),clarification:'件数カウントとしては実行できません。'};
    issueQueue=[{body,status}];
    const issue=await createSkillSearchTools(props).execute('salesforce','取引先を取得',undefined,undefined,{target:'accounts'});
    assert.equal(issue.status,'error');assert.equal(issue.reason,reason||'read_plan_clarification');assert.equal(issue.authoritativeText,undefined);
    issueQueue=[{body,status}];planning=[];
    const call=(id,query,target)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:'skill_search_salesforce',arguments:JSON.stringify({query,target})}}]});
    planned=[call('recoverable','取引先を取得','accounts'),call('successful','商談を取得','opportunities')];
    const before=fetches.length;
    const recovered=await runSkillSearch({...runnerProps,selectedAccount:undefined,selectedAccountRecord:undefined,history:[]});
    assert.equal(recovered.directContent,undefined);assert.ok(recovered.runner);assert.equal(fetches.length,before+2);
    const results=planning.at(-1).messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
    assert.equal(results[0].status,'error');assert.equal(results[1].reason,'query_completed');
    const runThreads=fetches.slice(before).map(f=>f.options.headers['X-Chat-Thread-Id']);assert.equal(new Set(runThreads).size,1);assert.notEqual(runThreads[0],'owned-thread');
  }
  issueQueue=[{status:422,body:{ok:false,error:'unsupported_condition',needs_clarification:true,owner_candidates:[{name:'黄 一郎',department:'営業一課'},{name:'黄 二郎',department:'営業二課'}]}}];
  const ownerChoice=await createSkillSearchTools(props).execute('salesforce','取引先を取得',undefined,undefined,{target:'accounts'});
  assert.equal(ownerChoice.status,'needs_confirmation');assert.ok(ownerChoice.authoritativeText.includes('黄 一郎'));assert.ok(ownerChoice.authoritativeText.includes('黄 二郎'));
  for(const status of [200,422]) {
    issueQueue=[{status,body:{ok:true,status:'needs_account_selection',needs_clarification:true,account_candidates:[{id:'001000000000001AAA',name:'Example',lightning_url:'https://test.sandbox.lightning.force.com/lightning/r/Account/001000000000001AAA/view'}]}}];
    const candidateTools=createSkillSearchTools(props);
    const candidate=await candidateTools.execute('salesforce','取引先を取得',undefined,undefined,{target:'accounts'});
    assert.equal(candidate.status,'needs_confirmation');assert.equal(candidate.data[0].Id,'001000000000001AAA');
    assert.ok(candidateTools.contextResults.some(v=>v.includes('skill_search_account_candidates')));
  }
  const beforeUnsafe=fetches.length;
  const unsafe=await createSkillSearchTools(props).execute('salesforce','複数の取引先を取得',undefined,undefined,{target:'accounts'});
  assert.equal(unsafe.reason,'query_rephrase_required');assert.equal(fetches.length,beforeUnsafe);
  mode='ok';planning=[];
  const lookupMessage='黄さんの最近の営業進捗をまとめて';
  const lookupCall={role:'assistant',content:null,tool_calls:[{id:'lookup-owner',type:'function',function:{name:'skill_search_salesforce',arguments:JSON.stringify({query:'黄さんの商談一覧を検索',owner:'黄',target:'opportunities'})}}]};
  planned=[lookupCall];
  await runSkillSearch({...runnerProps,chatThread:{id:'teams-empty-history'},message:lookupMessage,originalRequest:lookupMessage,history:[],selectedAccount:undefined,selectedAccountRecord:undefined});
  assert.deepEqual(planning[0].tool_choice,{type:'function',function:{name:'skill_search_salesforce'}},'A short owner name must trigger a lookup even with empty Teams history and no period');
  assert.equal(planning[1].tool_choice,undefined,'Only the initial lookup is required; subsequent clarification is allowed');
  q=fetches.at(-1).target.searchParams.get('q');
  assert.ok(q.includes('社内担当営業: 黄'));assert.ok(!q.includes('期間:'),'Do not invent a date range for 最近');
  for(const message of ['A社様の情報をまとめて','黄さんの営業進捗。Salesforceは使用しない。','Web情報だけで黄さんの営業進捗をまとめて']) {
    planning=[];planned=[];
    await runSkillSearch({...runnerProps,message,originalRequest:message,history:[],selectedAccount:undefined,selectedAccountRecord:undefined});
    assert.equal(planning[0].tool_choice,undefined,'Do not force Salesforce for company honorifics or explicit source exclusions');
  }
  // Execute the actual recommendation -> signed card -> common runner -> signed
  // personal Gateway path, rather than stubbing the Teams Skill runner.
  process.env.SKILL_SEARCH_ENABLED='true';process.env.TEAMS_BOT_ID='verified-test-bot';
  catalog=[{...runnerProps.skills[0],title:'担当者別・営業進捗レポート',description:'担当者の商談と活動を検索して営業進捗をまとめる'}];
  const {handleTeamsSkill}=load('features/teams/teams-skill-service.ts');
  const teamsProps={actor,conversation:'verified-conversation',activityId:'suggest-lookup',message:lookupMessage};
  const suggestion=await handleTeamsSkill(teamsProps);
  assert.ok(suggestion.card.actions.length);
  planning=[];planned=[lookupCall];const beforeTeamsLookup=fetches.length;
  const teamsReply=await handleTeamsSkill({...teamsProps,activityId:'execute-lookup',message:'',value:suggestion.card.actions[0].data});
  assert.ok(teamsReply.text.includes('取得できた営業進捗'));assert.equal(fetches.length,beforeTeamsLookup+1);
  assert.deepEqual(planning[0].tool_choice,{type:'function',function:{name:'skill_search_salesforce'}});
  assert.ok(fetches.at(-1).target.searchParams.get('q').includes('社内担当営業: 黄'));
  const teamsGatewayThread=fetches.at(-1).options.headers['X-Chat-Thread-Id'];assert.notEqual(teamsGatewayThread,'teams-verified-conversation');
  const teamsClaim=JSON.parse(Buffer.from(fetches.at(-1).options.headers['X-AC-Identity'],'base64url'));assert.equal(teamsClaim.thread,teamsGatewayThread);
  planning=[];mode='denied';
  const failed=await runSkillSearch(runnerProps);
  assert.equal(failed.runner,undefined);assert.ok(failed.directContent.includes('閲覧権限'));
  assert.equal(planning.length,0,'Revoked Account access must stop before model invocation');
  assert.ok(fetches.every(f=>f.target.origin==='https://personal.test'));
  mode='ok';process.env.SF_SKILL_READ_V2_ENABLED='true';
  const v2props={...props,userMessage:'黄さんの今期の失注商談をまとめて'};
  const v2=await createSkillSearchTools(v2props).execute('salesforce','黄さんの失注商談一覧',undefined,undefined,{owner:'黄',period:'今期',target:'opportunities'});
  assert.equal(v2.status,'empty');
  const v2fetch=fetches.at(-1);assert.equal(v2fetch.target.pathname,'/api/skills/salesforce/search');
  const v2body=JSON.parse(v2fetch.options.body);assert.equal(v2body.plan.owner.name,'黄');
  assert.equal(v2body.plan.period.expression,'今期');assert.equal(v2body.plan.stage.value,'lost');
  const v2claim=JSON.parse(Buffer.from(v2fetch.options.headers['X-AC-Identity'],'base64url'));
  assert.equal(v2claim.method,'POST');assert.equal(v2claim.body,createHash('sha256').update(v2fetch.options.body).digest('hex'));
  assert.equal(v2claim.thread,v2fetch.options.headers['X-Chat-Thread-Id']);
  issueQueue=[{status:422,body:{ok:false,error:'owner_not_found',error_kind:'owner_not_found',items:[]}}];
  const missingOwner=await createSkillSearchTools(v2props).execute('salesforce','黄さんの失注商談一覧',undefined,undefined,{owner:'黄',period:'今期',target:'opportunities'});
  assert.equal(missingOwner.reason,'owner_not_found');assert.ok(missingOwner.message.includes('0件という意味ではありません'));
  const {buildTypedSkillReadV2}=load('features/skills/execution/skill-read-v2.ts');
  for(const [query,message,scope] of [
    ['商談一覧','私の部下の商談',{target:'opportunities'}],
    ['商談一覧','黄さんの金額100万円以上の商談',{owner:'黄',target:'opportunities'}],
    ['黄さんの商談一覧','黄さんの商談',{owner:'別人',target:'opportunities'}],
    ['黄さんの商談を金額順に','黄さんの商談を金額順に',{owner:'黄',target:'opportunities'}],
  ])assert.throws(()=>buildTypedSkillReadV2(query,message,scope,'opportunities'),/型付きV2/,'Unsupported filters and invented owners must not be silently dropped');
  const reportRequest='黄さんの営業進捗をまとめて';
  for (const [query,target] of [['黄さんが担当している商談を取得してください','opportunities'],['商談一覧と金額・確度・失注理由','opportunities'],['活動を確認してください','activities']]) {
    const start=fetches.length;
    await createSkillSearchTools({...props,userMessage:reportRequest}).execute('salesforce',query,undefined,undefined,{owner:'黄',target});
    assert.equal(fetches.length,start+1);
    const sent=fetches.at(-1);assert.equal(sent.target.pathname,'/api/skills/salesforce/search');
    assert.equal(JSON.parse(sent.options.body).planVersion,'SF_READ_PLAN_V2');
  }
  const unsupportedStart=fetches.length;
  const unsupported=await createSkillSearchTools({...props,userMessage:reportRequest}).execute('salesforce','商談一覧',undefined,undefined,{owner:'黄',target:'opportunities',unsupportedConditions:['重要顧客だけ']});
  assert.equal(unsupported.reason,'v2_unsupported_conditions');assert.equal(fetches.length,unsupportedStart,'No NL fallback on unsupported predicates');
  for (const [message,scope] of [
    ['黄さんの失注商談',{owner:'黄',target:'opportunities',stage:'進行中'}],
    ['黄さんの商談',{owner:'黄',target:'opportunities',period:'今期'}],
    ['黄さんの活動',{owner:'黄',target:'activities',stage:'成約'}],
  ]) {
    const beforeRejected=fetches.length;
    const rejected=await createSkillSearchTools({...props,userMessage:message}).execute('salesforce','一覧を確認してください',undefined,undefined,scope);
    assert.equal(rejected.reason,'v2_unsupported_conditions');assert.equal(fetches.length,beforeRejected,'Conflicting stage and invented period must never fall back');
  }
  for (const channel of ['web','teams']) {
    const initial=fetches.length;
    planned=['opportunities','activities'].map((target,index)=>({role:'assistant',content:null,tool_calls:[{id:channel+index,type:'function',function:{name:'skill_search_salesforce',arguments:JSON.stringify({query:target==='opportunities'?'商談一覧と金額':'活動を確認してください',target,owner:'黄',unsupportedConditions:[]})}}]}));
    const result=await runSkillSearch({...runnerProps,chatThread:{id:channel==='teams'?'teams-v2-regression':'web-v2-regression'},message:'黄さんの商談と活動を確認して',originalRequest:'黄さんの商談と活動を確認して',history:[],selectedAccount:undefined,selectedAccountRecord:undefined});
    assert.ok(result.runner);
    const sent=fetches.slice(initial);assert.equal(sent.length,2);
    assert.deepEqual(sent.map(f=>JSON.parse(f.options.body).plan.object),['Opportunity','Activity']);
    for(const f of sent){assert.equal(f.target.origin,'https://personal.test');assert.equal(f.target.pathname,'/api/skills/salesforce/search');assert.equal(JSON.parse(f.options.body).planVersion,'SF_READ_PLAN_V2');}
    planned=[];const beforePrefetch=fetches.length;
    await runSkillSearch({...runnerProps,skills:[{...runnerProps.skills[0],content:'SalesforceのAccount・Opportunity・Activityを検索する'}],chatThread:{id:channel==='teams'?'teams-prefetch':'web-prefetch'},message:reportRequest,originalRequest:reportRequest,history:[],selectedAccount:undefined,selectedAccountRecord:undefined});
    assert.deepEqual(fetches.slice(beforePrefetch).map(f=>JSON.parse(f.options.body).plan.object),['Account','Opportunity','Activity'],'Basic progress must fetch required objects even if the model makes no tool calls');
  }
  delete process.env.SF_SKILL_READ_V2_ENABLED;
  console.log('PASS personal Skill signing, exact principal/thread/body, no shared fallback, proof lineage and current-access recheck');
})().catch(error=>{console.error(error);process.exitCode=1;});
