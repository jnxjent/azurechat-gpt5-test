const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
let owner = 'user-a';
let modelItems = [];
let modelFailure = false;
let conflict = false;
let offline = false;
let calls = 0;
let request;
let now = Date.now();
const originalNow = Date.now;
Date.now = () => now;
const documents = new Map();
let etag = 0;
const address = (id, user) => `${user}/${id}`;
const put = body => documents.set(address(body.id, body.userId), structuredClone({...body, _etag: String(++etag)}));
const container = {
  item(id, user) {
    assert.equal(user, owner, 'point reads and writes must use authenticated partition');
    return {
      async read() {
        if (offline) throw {code:503};
        const resource = documents.get(address(id,user));
        if (!resource) throw {code:404};
        return {resource:structuredClone(resource)};
      },
      async replace(body, options) {
        assert.equal(body.userId,owner);
        const old = documents.get(address(id,user));
        assert.equal(options.accessCondition.condition,old._etag);
        if (conflict) {
          conflict = false;
          put({...old, records:[...old.records, rules.mergeAutomaticMemories([], [candidate('parallel','profile','私は別のプロフィールも持っています')], 'parallel',now)[0]]});
          throw {code:412};
        }
        put(body);
      },
      async delete(options) {
        const old = documents.get(address(id,user));
        assert.equal(options.accessCondition.condition,old._etag);
        documents.delete(address(id,user));
      },
    };
  },
  items: {
    async create(body) {
      assert.equal(body.userId,owner);
      if (documents.has(address(body.id,owner))) throw {code:409};
      put(body);
    },
    query(spec, options) {
      assert.equal(options.partitionKey,owner);
      const params = Object.fromEntries(spec.parameters.map(p=>[p.name,p.value]));
      return {async fetchAll() {return {resources:[...documents.values()].filter(item=>item.userId===owner && item.type===params['@type'] && !item.isDeleted)};}};
    },
  },
};
const stubs = {
  'server-only': {},
  '@/features/auth-page/helpers': {
    async userHashedId() {if (!owner) throw Error('User not found'); return owner;},
    hashValue: email => require('node:crypto').createHash('sha256').update(email.trim().toLowerCase()).digest('hex'),
  },
  '@/features/common/services/cosmos': {HistoryContainer:()=>container},
  '@/features/common/services/openai': {OpenAIInstance:()=>({chat:{completions:{async create(body,options) {
    calls++; request={body,options};
    if (modelFailure) throw Error('do not log this secret or input');
    return {choices:[{message:{content:JSON.stringify({items:modelItems})}}]};
  }}}})},
};
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name).exports;
  const source = fs.readFileSync(path.join(__dirname,'../features/memory',`${name}.ts`),'utf8');
  const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const module={exports:{}}; cache.set(name,module);
  new Function('require','module','exports',js)(id=>Object.hasOwn(stubs,id)?stubs[id]:id.startsWith('./')?load(id.slice(2)):require(id),module,module.exports);
  return module.exports;
}
const rules=load('automatic-memory-rules');
const service=load('automatic-memory-service');
const candidate=(key,category,evidence,summary=evidence,terms=['デプロイ'])=>({key,category,evidence,summary,terms,emphasized:false});
const saved=()=>documents.get(address('automatic-memory-v1',owner));
const config=['AZURE_OPENAI_API_KEY','AZURE_OPENAI_API_DEPLOYMENT_NAME','AUTOMATIC_MEMORY_ENABLED'];
const oldConfig=config.map(key=>process.env[key]);

async function main() {
  process.env.AZURE_OPENAI_API_KEY='mock'; process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME='mock';
  delete process.env.AUTOMATIC_MEMORY_ENABLED;
  const profile='私は経営企画部でDXを担当しています。';
  modelItems=[candidate('department','profile',profile)];
  let context=await service.prepareAutomaticMemory(profile);
  assert.ok(context.includes('経営企画部'));
  assert.equal(saved().type,'USER_AUTOMATIC_MEMORY');
  assert.equal(saved().ttl,90*86400);
  assert.equal(saved().records[0].observations,1);
  assert.ok(!JSON.stringify(saved()).includes('evidence'), 'raw user evidence must not be stored');
  assert.equal(request.options.timeout,8000); assert.equal(request.options.maxRetries,0);
  assert.equal(request.body.max_completion_tokens,900);
  const firstExpiry=saved().records[0].expiresAt;
  const firstSeen=saved().records[0].lastConfirmedAt;
  const before=calls; now+=86400000;
  await service.prepareAutomaticMemory('こんにちは');
  assert.equal(calls,before,'ordinary short replies do not call extraction');
  assert.equal(rules.shouldExtractAutomaticMemory('このファイルをPDFに変換してください'),false,'ordinary one-off tasks do not spend extraction tokens');
  assert.equal(saved().records[0].expiresAt,firstExpiry,'recall never renews retention');
  assert.equal(saved().records[0].lastConfirmedAt,firstSeen);

  owner='user-b'; modelItems=[];
  assert.equal(await service.prepareAutomaticMemory('所属について教えてください'),'','other users cannot recall user-a');
  assert.equal(saved(),undefined);
  owner='user-a';
  const preference='デプロイの説明は日本語でしてください。';
  modelItems=[candidate('deploy.language','preference',preference)];
  assert.ok(!(await service.prepareAutomaticMemory(preference)).includes(preference),'one ordinary preference is provisional');
  assert.ok((await service.prepareAutomaticMemory(preference)).includes(preference),'repeated preference is used');
  assert.ok(!rules.formatAutomaticMemoryContext(saved().records,'天気を教えて').includes(preference),'unrelated preferences are omitted');
  const reportInstruction='今後、営業報告の要約は「結論・根拠・次の行動」の順にしてください。このルールを覚えておいてください。';
  const reportEvidence='営業報告の要約は「結論・根拠・次の行動」の順にしてください。';
  modelItems=[candidate('report.order','preference',reportEvidence,reportEvidence,['営業報告','要約'])];
  await service.prepareAutomaticMemory(reportInstruction);
  assert.equal(saved().records.find(item=>item.key==='report.order').emphasized,true,'an explicit request to remember is effective on the first observation even when the evidence omits the request');
  modelItems=[];
  context=await service.prepareAutomaticMemory('以下営業報告書を要約して。本文は次の通りです。');
  assert.ok(context.includes(reportEvidence),'a new request without restating the instruction recalls the saved order');
  const emphasized='本番へのデプロイは絶対禁止です。';
  modelItems=[candidate('deploy.guard','preference',emphasized)];
  assert.ok((await service.prepareAutomaticMemory(emphasized)).includes(emphasized),'explicit emphasis can be used immediately');
  const ownError='私はデプロイ先を間違えるミスをしました。';
  modelItems=[candidate('deploy.mistake','error_pattern',ownError)];
  assert.ok(!(await service.prepareAutomaticMemory(ownError)).includes(ownError),'one mistake is not a pattern');
  assert.ok((await service.prepareAutomaticMemory(ownError)).includes(ownError));
  const assistantError='私は困っています。あなたのデプロイでエラーが出ました。';
  assert.deepEqual(rules.validateAutomaticCandidates([candidate('ai.error','error_pattern',assistantError)],assistantError),[]);
  const correction='今後、アクトオフィスは個別の会議室名ではなく、アクト拠点の会議室として検索してください。';
  assert.equal(rules.shouldExtractAutomaticMemory(correction),true);
  const correctionItem=candidate('schedule.office','assistant_correction',correction,'アクトオフィスはアクト拠点の会議室として検索する',['アクト','会議室']);
  modelItems=[correctionItem];
  context=await service.prepareAutomaticMemory(correction);
  assert.ok(context.includes(correctionItem.summary),'explicit assistant corrections are available immediately');
  assert.equal(saved().records.find(item=>item.key==='schedule.office').category,'assistant_correction','AI feedback is never attributed to the user as their mistake');
  assert.ok(rules.formatAutomaticMemoryContext(saved().records,'アクトで会議をしたい').includes(correctionItem.summary),'relevant later requests recall the correction');
  assert.ok(!rules.formatAutomaticMemoryContext(saved().records,'料理の作り方を教えて').includes(correctionItem.summary),'unrelated answers omit corrections');
  for(const vague of ['それは違う','今後直して','それは違う。今後直してください。']) {
    assert.deepEqual(rules.validateAutomaticCandidates([candidate('vague','assistant_correction',vague,'invented correct answer',['今後'])],vague),[],'vague feedback cannot invent a lesson');
    assert.ok(rules.assistantFeedbackClarification(vague).includes('確認'),'vague feedback asks for the correct behavior');
  }
  assert.equal(rules.assistantFeedbackClarification(correction),'');
  assert.equal(rules.assistantFeedbackClarification('これは別の話題です。'),'');
  const revised='今後、アクトオフィスの会議室は応接室を優先してください。';
  modelItems=[candidate('schedule.office','assistant_correction',revised,revised,['アクト'])];
  context=await service.prepareAutomaticMemory(revised);
  assert.ok(context.includes(revised));
  assert.ok(!context.includes(correctionItem.summary),'later correction replaces the same topic');
  assert.equal(saved().records.filter(item=>item.key==='schedule.office').length,1);
  assert.deepEqual(rules.validateAutomaticCandidates([candidate('unsupported','assistant_correction',correction,'invented',['料理'])],correction),[],'topic needs supporting evidence');
  assert.deepEqual(rules.validateAutomaticCandidates([candidate('invented','profile','私は部長です')],profile),[],'unsupported evidence rejected');
  assert.deepEqual(rules.validateAutomaticCandidates([candidate('thirdparty','profile','田中さんは部長です')],'田中さんは部長です'),[]);
  assert.equal(rules.automaticMemoryInput('API_KEY=sk-secretvalue123456\n> 私は引用です\n```\n私はコードです\n```'),'');
  assert.deepEqual(rules.validateAutomaticCandidates([candidate('secret','profile',profile,'API_KEY=secret')],profile),[]);

  const corrected='私は営業部へ異動しました。';
  modelItems=[candidate('department','profile',corrected)];
  context=await service.prepareAutomaticMemory(corrected);
  assert.ok(context.includes('営業部')); assert.ok(!context.includes('経営企画部'));
  assert.equal(saved().records.filter(item=>item.key==='department').length,1);
  assert.equal(saved().records.find(item=>item.key==='department').observations,1);
  conflict=true; modelItems=[candidate('role','profile',profile)];
  await service.prepareAutomaticMemory(profile);
  assert.ok(saved().records.some(item=>item.key==='parallel'),'conflict retry preserves another concurrent write');
  assert.ok(saved().records.some(item=>item.key==='role'));
  const list=await load('memory-service').listUserMemories();
  assert.deepEqual(list,[],'hidden automatic records never appear in legacy memory API/list');
  modelFailure=true;
  assert.ok((await service.prepareAutomaticMemory(profile)).includes('営業部'),'extraction failure preserves recall');
  modelFailure=false; offline=true;
  assert.equal(await service.prepareAutomaticMemory(profile),'','storage failure does not block chat');
  offline=false; owner='';
  assert.equal(await service.prepareAutomaticMemory(profile),'','unauthenticated requests have no memory');
  owner='user-a'; process.env.AUTOMATIC_MEMORY_ENABLED='false';
  const disabledCalls=calls; assert.equal(await service.prepareAutomaticMemory(profile),''); assert.equal(calls,disabledCalls);
  delete process.env.AUTOMATIC_MEMORY_ENABLED;

  const noGroupCalls=calls;
  for (const conversationType of ['groupChat','channel',undefined]) {
    assert.equal(await service.prepareTeamsAutomaticMemory({verifiedEmail:'user@example.com',conversationType,message:profile}), '');
  }
  assert.equal(await service.prepareTeamsAutomaticMemory({conversationType:'personal',message:profile}), '');
  assert.equal(calls,noGroupCalls,'group/channel/unidentified users cannot extract or recall');
  const webOwner=owner;
  owner=stubs['@/features/auth-page/helpers'].hashValue('user@example.com');
  modelItems=[candidate('department','profile',profile)];
  assert.ok((await service.prepareTeamsAutomaticMemory({verifiedEmail:'USER@example.com',conversationType:'personal',message:profile,activityId:'activity1'})).includes('経営企画部'));
  await service.prepareTeamsAutomaticMemory({verifiedEmail:'user@example.com',conversationType:'personal',message:profile,activityId:'activity1'});
  assert.equal(saved().records[0].observations,1,'Teams retries use the same observation source');
  modelItems=[];
  assert.ok((await service.prepareAutomaticMemory('所属について教えてください')).includes('経営企画部'),'same account shares private memory across Web and Teams');
  owner=webOwner;

  const t=now;
  const one=rules.mergeAutomaticMemories([], [candidate('test','profile',profile)],'same-source',t);
  assert.equal(rules.mergeAutomaticMemories(one,[candidate('test','profile',profile)],'same-source',t+1)[0].observations,1,'source retry does not double count');
  assert.equal(rules.mergeAutomaticMemories(one,[candidate('test','profile',profile,'old profile')],'slow-source',t+1,t-1)[0].summary,profile,'a slow earlier extraction cannot overwrite a newer correction');
  assert.equal(rules.activeAutomaticMemories(one,t+90*86400000).length,0,'exact 90-day boundary expires');
  const recurring=rules.mergeAutomaticMemories(one,[candidate('test','profile',profile)],'next-source',t+89*86400000);
  assert.equal(rules.activeAutomaticMemories(recurring,t+91*86400000)[0].observations,1,'old occurrences do not establish a recent repeated pattern');
  const many=Array.from({length:60},(_,i)=>candidate(`key${i}`,'profile',profile,'私は'+ 'あ'.repeat(100),['説明']));
  const bounded=rules.mergeAutomaticMemories([],many,'source',t);
  assert.ok(bounded.length<=20);
  assert.ok(Buffer.byteLength(bounded.map(item=>item.summary).join(''),'utf8')<=rules.AUTO_MEMORY_SUMMARY_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded),'utf8')<=rules.AUTO_MEMORY_RECORDS_BYTES);
  assert.equal(rules.mergeAutomaticMemories([],many.map(item=>({...item,summary:'Short profile'})),'source',t).length,20);
  const prompt=rules.formatAutomaticMemoryContext(bounded,'説明',t);
  assert.ok(Buffer.byteLength(prompt,'utf8')<=rules.AUTO_MEMORY_CONTEXT_BYTES);
  assert.ok(prompt.length<=rules.AUTO_MEMORY_CONTEXT_CHARS);
  now+=91*86400000; modelItems=[];
  assert.equal(await service.prepareAutomaticMemory('こんにちは'),'');
  assert.equal(saved(),undefined,'expired stored records are physically removed on access');
  for (let i=0;i<35;i++) {
    const text=`私は担当${i}です。`;
    modelItems=[candidate(`profile${i}`,'profile',text)];
    await service.prepareAutomaticMemory(text);
  }
  assert.equal(saved().records.length,20,'continued conversations cannot grow stored memory beyond its limit');
  assert.ok(saved().records.some(item=>item.key==='profile34'),'recent facts displace older ones');
  assert.ok(Buffer.byteLength(JSON.stringify(saved()),'utf8')<=rules.AUTO_MEMORY_DOCUMENT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(request.body.messages[1].content).existingTopics),'utf8')<=1800,'extraction input also has a fixed prior-memory budget');
  assert.deepEqual(rules.validateAutomaticCandidates([candidate('long','profile',profile,'あ'.repeat(161))],profile),[]);
  console.log('PASS automatic memory: ownership, hidden storage, evidence, repetition, corrections, concurrency, 90-day expiry, cleanup, prompt budgets and failure fallback');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  Date.now=originalNow;
  config.forEach((key,i)=>{if(oldConfig[i]===undefined)delete process.env[key];else process.env[key]=oldConfig[i];});
});
