const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {createHash} = require('node:crypto');
const {EventEmitter} = require('node:events');
const principal = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
const actor = {email:'owner@example.test',salesforcePrincipal:principal};
let currentActor = actor, allowed = true, fetches = [], mode='ok', planning=[];
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
    chat: {completions: {create: async p => {planning.push(p); return {choices:[{message:{role:'assistant',content:'ready'}}]};}}},
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
  const operation=options.body ? JSON.parse(options.body).operation : 'count';
  const records=operation==='accounts'?[{Id:'001000000000001AAA',Name:'Example',lightning_url:'https://sf.test/account'}]:[];
  return new Response(JSON.stringify({ok:mode!=='denied',object:operation==='accounts' || operation==='count' ?'Account':'Opportunity',items:records,snapshot_proof:mode==='no-proof' || operation==='count' ?null:'proof-for-'+operation,...(operation==='count'?{aggregation_result:{func:'COUNT',value:7,source:'soql_count',scope:'all'}}:{})}),{status:mode==='denied'?403:200,headers:{'X-SF-Connection-Mode':'personal-oauth','X-AC-Principal':mode==='wrong-person'?'foreign':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
};
const {createSkillSearchTools}=load('features/skills/execution/skill-search-tools.ts');
const {mergeSkillSnapshots}=load('features/skills/execution/skill-personal-access.ts');
const {runSkillSearch}=load('features/skills/execution/skill-search-runner.ts');
assert.equal(process.env.SF_PERSONAL_MODE,'true');
assert.equal(load('features/common/services/salesforce-personal.ts').personalSalesforceForEmail(actor.email),true);
const props={email:actor.email,threadId:'owned-thread',userMessage:'Exampleを訪問したい',signal:new AbortController().signal};
(async()=>{
  const tool=createSkillSearchTools(props);
  assert.equal((await tool.execute('salesforce','Exampleの取引先を検索','Example','accounts')).status,'ok');
  assert.equal(fetches[0].target.origin,'https://personal.test');
  assert.equal(fetches[0].target.pathname,'/api/skills/salesforce/search');
  assert.equal(fetches[0].options.headers['X-Skill-Read-Key'],undefined);
  assert.equal(fetches[0].options.headers['X-Chat-Thread-Id'],'owned-thread');
  const claim=JSON.parse(Buffer.from(fetches[0].options.headers['X-AC-Identity'],'base64url'));
  assert.equal(claim.principal,principal);assert.equal(claim.method,'POST');
  assert.equal(claim.body,createHash('sha256').update(fetches[0].options.body).digest('hex'));
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
  const selected={id:'001000000000001AAA',name:'Example'};
  const runnerProps={chatThread:{id:'owned-thread'},email:actor.email,skills:[{id:'skill-'+'a'.repeat(64),title:'訪問準備',version:1,content:'Salesforce Account Opportunityを調べる',enabled:true}],message:'Skill「訪問準備」を使って、Exampleを訪問したい',originalRequest:'Exampleを訪問したい',history:[],signal:props.signal,selectedAccount:selected,selectedAccountRecord:{Id:selected.id,Name:'OLD SECRET SNAPSHOT'}};
  const start=fetches.length;
  const result=await runSkillSearch(runnerProps);
  assert.ok(fetches.length>start);
  assert.equal(JSON.parse(fetches[start].options.body).operation,'accounts','Recheck selected Account before related searches');
  assert.ok(!JSON.stringify(planning).includes('OLD SECRET SNAPSHOT'));
  assert.ok(result.salesforceSnapshot.proofs.includes('proof-for-accounts'));
  const autoStart=fetches.length;
  await runSkillSearch({...runnerProps,message:'Skill「訪問準備」を使って、Example株式会社を訪問したい',originalRequest:'Example株式会社を訪問したい',selectedAccount:undefined,selectedAccountRecord:undefined});
  assert.ok(fetches.slice(autoStart).some(f=>JSON.parse(f.options.body).operation==='opportunities'),'One matching company must continue to related data without extra selection');
  planning=[];mode='denied';
  const failed=await runSkillSearch(runnerProps);
  assert.equal(failed.runner,undefined);assert.ok(failed.directContent.includes('閲覧権限'));
  assert.equal(planning.length,0,'Revoked Account access must stop before model invocation');
  assert.ok(fetches.every(f=>f.target.origin==='https://personal.test'));
  console.log('PASS personal Skill signing, exact principal/thread/body, no shared fallback, proof lineage and current-access recheck');
})().catch(error=>{console.error(error);process.exitCode=1;});
