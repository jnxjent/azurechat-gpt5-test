const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const crypto = require('node:crypto');
const records = new Map();
let counter = 0, requests = [], agentResponses = [];
const key = (id, owner) => `${owner}/${id}`;
const copy = value => JSON.parse(JSON.stringify(value));
const container = {
  item(id, owner) { return {
    async read() { const resource = records.get(key(id, owner)); if (!resource) throw {code: 404}; return {resource: copy(resource)}; },
    async replace(value, options) {
      const old = records.get(key(id, owner));
      if (old?._etag !== options.accessCondition.condition) throw {code: 412};
      const resource = {...copy(value), _etag: String(++counter)}; records.set(key(id, owner), resource); return {resource};
    },
    async delete(options) {
      const old = records.get(key(id, owner));
      if (options && old?._etag !== options.accessCondition.condition) throw {code: 412};
      records.delete(key(id, owner));
    },
  }; },
  items: {
    async create(value) { if (records.has(key(value.id, value.userId))) throw {code: 409}; return this.upsert(value); },
    async upsert(value) { const resource = {...copy(value), _etag: String(++counter)}; records.set(key(value.id, value.userId), resource); return {resource}; },
    query(query, options) {
      assert.equal(query.parameters.find(p=>p.name==='@userId').value, options.partitionKey);
      assert.equal(query.parameters.find(p=>p.name==='@type').value, 'USER_MEMORY');
      return {async fetchAll() { return {resources: [{enabled:true,memoryClass:'profile',content:'優先会議室：有玉会議室'}]}; }};
    },
  },
};
const mocks = {
  'server-only': {},
  '@/features/common/services/cosmos': {HistoryContainer: ()=>container},
  '@/features/desknets-agent/desknets-agent-transport': {async fetchDeskNetsAgent(url, init) {
    requests.push({url, ...init, body: init.body ? JSON.parse(init.body) : undefined});
    let response = agentResponses.shift();
    if (typeof response === 'function') response = await response();
    if (response instanceof Error) throw response;
    assert.ok(response, 'unexpected agent request');
    return {ok: true, status:200, async json() {return copy(response);}};
  }},
};
const loaded = new Map();
function load(file) {
  file=path.resolve(file);
  if (loaded.has(file)) return loaded.get(file);
  const exports={}; loaded.set(file,exports);
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const requireFile=name=>name in mocks ? mocks[name] : name.startsWith('@/') ? load(name.slice(2)+'.ts') : name.startsWith('.') ? load(path.resolve(path.dirname(file),name+'.ts')) : require(name);
  Function('require','module','exports',js)(requireFile,{exports},exports);
  return exports;
}
const service=load('features/teams/teams-desknets-service.ts');
const client=load('features/teams/teams-desknets-client.ts');
const handoff=load('features/desknets-agent/desknets-handoff-url.ts');
process.env.DESKNETS_AGENT_API_URL='https://agent.example.test';
process.env.DESKNETS_AGENT_API_KEY='test-key';
process.env.NEXTAUTH_URL='https://azurechat-gpt5-test.azurewebsites.net';
const props={userEmail:' User@midac.jp ',conversationId:'conversation',activityId:'1',conversationType:'personal',message:'DeskNetsで私と部長の空き時間を確認して'};
const approval={title:'打ち合わせ',start:'2030-01-01T01:00:00Z',end:'2030-01-01T02:00:00Z',participantIds:['部長'],facilityId:'有玉会議室',emailNotificationWillBeSent:true};
async function main() {
  const owner=client.teamsDeskNetsOwner(props.userEmail,props.conversationId);
  assert.equal(owner.userId,crypto.createHash('sha256').update('user@midac.jp').digest('hex'));
  assert.notEqual(owner.threadId,client.teamsDeskNetsOwner('other@midac.jp',props.conversationId).threadId);
  assert.equal(await service.handleTeamsDeskNets({...props,message:'こんにちは'}),null);
  assert.equal(await service.handleTeamsDeskNets({...props,message:'SharePointからDeskNetsの操作方法を探して'}),null);
  assert.ok((await service.handleTeamsDeskNets({...props,userEmail:null})).text.includes('本人'));
  assert.ok((await service.handleTeamsDeskNets({...props,conversationType:'groupChat'})).text.includes('個人'));
  assert.equal(requests.length,0);
  agentResponses.push({id:'run1',status:'completed',result:{assistantMessage:'候補は開始時刻順です。\n1. 2030/1/1 10:00\n2. 2030/1/2 10:00'}});
  const first=await service.handleTeamsDeskNets(props);
  assert.ok(first.text.includes('候補は開始時刻順'));
  assert.equal(requests[0].body.mode,'read');
  assert.equal(requests[0].body.userId,owner.userId);
  assert.equal(requests[0].headers['x-user-email'],'user@midac.jp');
  assert.equal(requests[0].body.defaultFacilityQuery,'有玉会議室');
  assert.equal(requests[0].body.prompt,props.message);
  assert.deepEqual(await service.handleTeamsDeskNets(props),first);
  assert.equal(requests.length,1,'duplicate activity must not resubmit');
  agentResponses.push({id:'run2',status:'awaiting_approval',result:{assistantMessage:'候補2を選びました。',approvalRequest:approval}});
  const selected=await service.handleTeamsDeskNets({...props,activityId:'2',message:'では、2で'});
  assert.ok(selected.confirmationUrl.includes('runId=run2'));
  assert.ok(selected.text.includes('まだ予定は登録していません'));
  assert.ok(requests[1].body.conversationHistory.some(m=>m.content.includes('候補は開始時刻順')));
  agentResponses.push({id:'run3',status:'awaiting_approval',result:{assistantMessage:'16時に変更しました。',approvalRequest:approval}});
  const changed=await service.handleTeamsDeskNets({...props,activityId:'3',message:'16時開始で'});
  assert.ok(changed.confirmationUrl.includes('runId=run3'));
  assert.equal(requests[2].body.threadId,owner.threadId);
  assert.equal(await service.handleTeamsDeskNets({...props,activityId:'4',message:'SharePointから就業規則を検索して'}),null);
  assert.equal(await service.handleTeamsDeskNets({...props,activityId:'5',message:'60分'}),null,'topic change must clear scheduling');
  agentResponses.push({id:'run4',status:'completed',result:{assistantMessage:'別の候補です。'}});
  await service.handleTeamsDeskNets({...props,userEmail:'other@midac.jp',activityId:'6'});
  assert.deepEqual(requests[3].body.conversationHistory,[]);
  agentResponses.push({id:'run5',status:'queued'},{id:'run5',status:'completed',result:{assistantMessage:'候補を確認しました。'}});
  const queued=await service.handleTeamsDeskNets({...props,activityId:'7'});
  assert.ok(queued.text.includes('候補を確認'));
  assert.ok(requests.at(-1).url.endsWith('/run5'));
  agentResponses.push(new Error('timeout'));
  const uncertain=await service.handleTeamsDeskNets({...props,activityId:'8',message:'16時開始で'});
  const before=requests.length;
  assert.ok(uncertain.text.includes('自動再実行'));
  await service.handleTeamsDeskNets({...props,activityId:'8',message:'16時開始で'});
  await service.handleTeamsDeskNets({...props,activityId:'9',message:'状況を確認して'});
  assert.equal(requests.length,before,'POST timeout must not replay');
  await service.handleTeamsDeskNets({...props,activityId:'10',message:'/reset'});
  assert.equal(await service.handleTeamsDeskNets({...props,activityId:'11',message:'60分'}),null);
  let release;
  agentResponses.push(()=>new Promise(resolve=>{release=resolve;}));
  const inFlight=service.handleTeamsDeskNets({...props,activityId:'12'});
  await new Promise(resolve=>setImmediate(resolve));
  const concurrentCount=requests.length;
  const busy=await service.handleTeamsDeskNets({...props,activityId:'13'});
  assert.ok(busy.text.includes('処理中'));
  assert.equal(requests.length,concurrentCount,'concurrent delivery must not issue another POST');
  release({id:'run6',status:'completed',result:{assistantMessage:'候補です。'}});
  await inFlight;
  assert.notEqual(requests[requests.length-1].body.threadId,owner.threadId,"reset must isolate the backend conversation");
  const stateRecord=[...records.values()].find(r=>r.userId===owner.userId&&r.type==='TEAMS_DESKNETS_STATE');
  stateRecord.updatedAt=Date.now()-25*60*60*1000;
  assert.equal(await service.handleTeamsDeskNets({...props,activityId:'14',message:'60分'}),null,'expired state must not resume');
  const expiredLock={id:stateRecord.id+'-lock',userId:owner.userId,type:'TEAMS_DESKNETS_LOCK',expiresAt:Date.now()-1,_etag:'expired'};
  records.set(key(expiredLock.id,owner.userId),expiredLock);
  agentResponses.push({id:'run7',status:'completed',result:{assistantMessage:'新しい候補です。'}});
  await service.handleTeamsDeskNets({...props,activityId:'15'});
  assert.equal(records.has(key(expiredLock.id,owner.userId)),false,'expired lock must recover and release');
  // A run completing after the old 15-second limit delivers its result in the
  // original turn, without a status message or a second scheduling POST.
  const realNow=Date.now, realTimeout=global.setTimeout;
  let elapsed=0, waiting=[], startedAfterNotice=false;
  Date.now=()=>realNow()+elapsed;
  global.setTimeout=(callback)=>realTimeout(callback,0);
  const delayedProps={...props,conversationId:'delayed-conversation',activityId:'delayed',onWaiting:async message=>{waiting.push(message);}};
  const countBefore=requests.length;
  agentResponses.push(()=>{startedAfterNotice=waiting.length===1;return {id:'delayed-run',status:'running'};});
  agentResponses.push(()=>{elapsed+=20000;return {id:'delayed-run',status:'running'};});
  agentResponses.push(()=>{elapsed+=40000;return {id:'delayed-run',status:'completed',result:{assistantMessage:'来週の候補です。'}};});
  try {
    const delivered=await service.handleTeamsDeskNets(delayedProps);
    assert.equal(startedAfterNotice,true,'waiting notice must precede scheduling work');
    assert.deepEqual(waiting,['少々お待ちください。結果判明したらお知らせします。']);
    assert.ok(delivered.text.includes('来週の候補です。'));
    assert.equal(requests.slice(countBefore).filter(r=>r.method==='POST').length,1);
    assert.equal(requests.slice(countBefore).filter(r=>r.method==='GET').length,2);
  } finally {Date.now=realNow;global.setTimeout=realTimeout;}
  const valid='https://desknets.midac.jp/dneo/dneo.cgi?cmd=schindex#cmd=schaddtarget&date=20300101';
  assert.equal(handoff.validatedDeskNetsHandoffUrl(valid),valid);
  for (const url of ['https://evil.test/dneo/dneo.cgi?cmd=schindex#cmd=schaddtarget',valid.replace('https:','http:'),valid.replace('schaddtarget','delete'),valid.replace('desknets.midac.jp','user@desknets.midac.jp')]) assert.throws(()=>handoff.validatedDeskNetsHandoffUrl(url));
  assert.ok(requests.every(r=>r.method==='GET'||r.body.mode==='read'));
  console.log('Teams DeskNets tests passed: identity, routing, history, selection, changes, deduplication, async runs, timeout, handoff URL.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
