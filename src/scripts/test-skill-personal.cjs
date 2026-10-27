const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {createHash} = require('node:crypto');
const {EventEmitter} = require('node:events');
const principal = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
const actor = {email:'owner@example.test',salesforcePrincipal:principal};
let currentActor = actor, allowed = true, fetches = [], mode='ok', planning=[], planned=[];
const stubs = {
  'server-only':{},
  '@/features/canvas/canvas-actor':{getCanvasActor:async()=>currentActor},
  '@/features/common/services/salesforce-access':{isSalesforceAllowedEmail:()=>allowed},
  './salesforce-access':{isSalesforceAllowedEmail:()=>allowed},
  '@/features/common/services/salesforce-routing':{buildSalesforceGatewayQuery:q=>q},
  '@/features/chat-page/chat-services/azure-ai-search/azure-ai-search':{},
  '@/features/chat-page/chat-services/chat-api/chat-api-rag':{},
  '@/features/chat-page/chat-services/citation-service':{},
  '@/features/teams/teams-brave-search-service':{isTeamsBraveSearchConfigured:()=>false},
  '@/features/common/services/openai': {OpenAIInstance: () => ({
    chat: {completions: {create: async p => {planning.push(p); return {choices:[{message:planned.shift() ?? {role:'assistant',content:'ready'}}]};}}},
    beta: {chat: {completions: {stream: () => {const e = new EventEmitter(); setImmediate(()=>e.emit('end'));return e;}}}},
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
  if(mode==='invalid-company')return Response.json({ok:false,error:'invalid_company'},{status:400});
  if(mode==='context-missing-422' || mode==='context-missing-200')return Response.json({ok:false,error:'context_missing',error_kind:'context_missing',needs_clarification:true,message:'引き継ぐ件数検索の条件がありません。対象と条件を含めて質問してください。'},{status:mode==='context-missing-422'?422:200,headers:{'X-SF-Connection-Mode':'personal-oauth','X-AC-Principal':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
  const q=target.searchParams.get('q') || '';
  const operation=options.body ? JSON.parse(options.body).operation : /件数/.test(q) ? 'count' : /商談|opportunities/.test(q) ? 'opportunities' : /活動|activities/.test(q) ? 'activities' : 'accounts';
  const records=operation==='accounts'?[{Id:'001000000000001AAA',Name:'Example',lightning_url:'https://sf.test/account'}]:[];
  return new Response(JSON.stringify({ok:mode!=='denied',object:mode==='wrong-object'?'Contact':operation==='accounts' || operation==='count' ?'Account':operation==='activities'?'Activity':operation==='sales'?'SalesSummary':'Opportunity',items:records,snapshot_proof:mode==='no-proof' || operation==='count' ?null:'proof-for-'+operation,...(operation==='count'?{aggregation_result:{func:'COUNT',value:7,source:'soql_count',scope:'all'}}:{})}),{status:mode==='denied'?403:200,headers:{'X-SF-Connection-Mode':'personal-oauth','X-AC-Principal':mode==='wrong-person'?'foreign':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
};
const {createSkillSearchTools}=load('features/skills/execution/skill-search-tools.ts');
const {mergeSkillSnapshots}=load('features/skills/execution/skill-personal-access.ts');
const {runSkillSearch}=load('features/skills/execution/skill-search-runner.ts');
const {resolveSkillSalesforceScope,buildSkillSalesforceQuery}=load('features/skills/execution/skill-salesforce-scope.ts');
const continuationPattern=/そのうち|その中で|検索.*(?:くれた|した|対象|条件)|(?:先ほど|さっき|直前).*(?:条件|対象|範囲)/;
for(const target of [undefined,'accounts','opportunities','activities','contacts','sales','count'])
  for(const company of [undefined,'Example株式会社'])
    for(const owner of [undefined,'黄'])
      for(const period of [undefined,'今期',{start:'2026-04-01',end:'2027-04-01'}]) {
        const q=buildSkillSalesforceQuery('黄さんが担当する取引先を検索',{target,company,owner,period});
        assert.equal(continuationPattern.test(q),false,q);
        assert.ok(q.startsWith('黄さんが担当する取引先を検索'));
        if(target)assert.ok(q.includes('種類: '));
      }
assert.ok(buildSkillSalesforceQuery('さっきの検索条件で取引先を検索',{target:'accounts'}).startsWith('さっきの検索条件で取引先を検索'),'Preserve user-authored continuation semantics');
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
  assert.equal(fetches[0].options.headers['X-Chat-Thread-Id'],'owned-thread');
  const claim=JSON.parse(Buffer.from(fetches[0].options.headers['X-AC-Identity'],'base64url'));
  assert.equal(claim.principal,principal);assert.equal(claim.method,'GET');
  assert.equal(claim.body,createHash('sha256').update('').digest('hex'));
  assert.deepEqual(tool.salesforceSnapshot.proofs,['proof-for-accounts']);
  mode='no-proof';
  await tool.execute('salesforce','Exampleの取引先を検索','Example','accounts');
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
  assert.equal((await createSkillSearchTools(props).execute('salesforce','取引先を検索','Example','accounts')).status,'error');
  assert.equal(fetches.length,count,'Identity mismatch must not use any shared fallback');
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
    assert.ok(sent.target.searchParams.get('q').includes('担当者: 黄'),'Preserve requested employee even when the tool query omits the name');
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
  sent=fetches.at(-1);q=sent.target.searchParams.get('q');assert.ok(q.length<=500);assert.ok(q.startsWith('商談一覧を検索'));assert.ok(q.includes('担当者: 黄'));assert.ok(q.includes('期間: 今期'));
  const signed=JSON.parse(Buffer.from(sent.options.headers['X-AC-Identity'],'base64url'));
  assert.ok(sent.options.headers['X-AC-Identity'].length<=3000,'Percent-encoded Japanese must fit the Gateway identity limit');
  assert.equal(signed.target,sent.target.pathname+sent.target.search);
  const {createHmac}=require('node:crypto');assert.equal(sent.options.headers['X-AC-Signature'],createHmac('sha256',process.env.SF_PERSONAL_SIGNING_KEY).update(sent.options.headers['X-AC-Identity']).digest('hex'));
  const badBefore=fetches.length;
  assert.equal((await toyota.execute('salesforce','商談一覧',undefined,undefined,{owner:123})).status,'error');assert.equal(fetches.length,badBefore);
  const forwardStart=fetches.length;
  planned=[{role:'assistant',content:null,tool_calls:[{id:'call-scope',type:'function',function:{name:'skill_search_salesforce',arguments:JSON.stringify({query:'商談一覧を検索',company:'トヨタ',owner:'黄',period:'今期',target:'opportunities'})}}]}];
  await runSkillSearch({...runnerProps,message:'黄さんの担当するトヨタの今期の商談',originalRequest:'黄さんの担当するトヨタの今期の商談',selectedAccount:undefined,selectedAccountRecord:undefined});
  assert.equal(fetches.length,forwardStart+1);q=fetches.at(-1).target.searchParams.get('q');assert.ok(q.includes('会社: トヨタ') && q.includes('担当者: 黄') && q.includes('期間: 今期'));
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
  planning=[];mode='denied';
  const failed=await runSkillSearch(runnerProps);
  assert.equal(failed.runner,undefined);assert.ok(failed.directContent.includes('閲覧権限'));
  assert.equal(planning.length,0,'Revoked Account access must stop before model invocation');
  assert.ok(fetches.every(f=>f.target.origin==='https://personal.test'));
  console.log('PASS personal Skill signing, exact principal/thread/body, no shared fallback, proof lineage and current-access recheck');
})().catch(error=>{console.error(error);process.exitCode=1;});
