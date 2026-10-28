const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const {EventEmitter}=require('node:events');
let work,executions=0,version=0,createFails=false,createDelay=0;
const rows=new Map(),saved=[];
const clone=value=>JSON.parse(JSON.stringify(value));
const error=code=>Object.assign(Error('fixture'),{code});
const container={items:{create:async(record,options)=>{
  if(createDelay){await new Promise(resolve=>setTimeout(resolve,createDelay));if(options.abortSignal.aborted)throw error(408);}
  if(createFails)throw error(503);const key=record.userId+record.id;if(rows.has(key))throw error(409);
  const resource={...clone(record),_etag:String(++version)};rows.set(key,resource);return {resource:clone(resource)};
}},item:(id,owner)=>({read:async()=>({resource:clone(rows.get(owner+id))}),replace:async(record,options)=>{
  const old=rows.get(owner+id);assert.equal(options.accessCondition.condition,old._etag);
  const resource={...clone(record),_etag:String(++version)};rows.set(owner+id,resource);return {resource:clone(resource)};
}})};
const stubs={
 'server-only':{},
 '@/features/common/services/cosmos':{HistoryContainer:()=>container},
 './teams-skill-service':{skillSubmission:value=>value?.feature==='ac.skill'?value:undefined,handleTeamsSkill:async props=>{executions++;return work(props);}},
 './teams-skill-card':{verifySkillCard:(token,actor,conversation)=>{if(token!=='valid-'+conversation||actor.salesforcePrincipal!=='tenant:owner')throw error(403);return {}; }},
 '@/features/theme/theme-config':{AI_NAME:'AI'},
 '../chat-message-service':{CreateChatMessage:async value=>saved.push(value)},
};
const cache=new Map();function load(file){file=path.resolve(__dirname,'..',file);if(cache.has(file))return cache.get(file);const m={exports:{}};cache.set(file,m.exports);
 new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{
 if(Object.hasOwn(stubs,id))return stubs[id];if(id.startsWith('.'))return load(path.resolve(path.dirname(file),id+'.ts'));if(id.startsWith('@/'))return load(id.slice(2)+'.ts');return require(id);
 },m,m.exports);cache.set(file,m.exports);return m.exports;
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let i=0;i<30;i++)await tick();}
function props(conversation,send){return {actor:{email:'owner@example.test',salesforcePrincipal:'tenant:owner'},conversation,activityId:'first',value:{feature:'ac.skill',token:'valid-'+conversation},send};}
(async()=>{
 process.env.TEAMS_SKIP_AUTH='false';process.env.TEAMS_BOT_ID='fixture-bot';
 const {splitTeamsSkillText,TEAMS_SKILL_TEXT_BYTES}=load('features/teams/teams-skill-delivery.ts');
 const header='| Account | Opportunity |\n| --- | --- |';
 const table=header+'\n'+Array.from({length:120},(_,i)=>`| 顧客${i} | [商談${i}](https://example.test/${'x'.repeat(180)}/${i}) |`).join('\n');
 const parts=splitTeamsSkillText(table);assert.ok(parts.length>1);
 for(const part of parts){assert.ok(Buffer.byteLength(JSON.stringify({type:'message',text:part}))<=TEAMS_SKILL_TEXT_BYTES);assert.ok(part.includes(header));}
 assert.equal((parts.join('\n').match(/\[商談\d+\]/g)||[]).length,120,'Every linked row appears once');
 const fence='```text\n'+('data\n'.repeat(100))+'```';assert.ok(splitTeamsSkillText(table+'\n\n'+fence).some(p=>p.includes(fence)));
 assert.throws(()=>splitTeamsSkillText('[huge](https://example.test/'+ 'x'.repeat(25000)+')'),/line_too_large/);
 const {acceptTeamsSkillJob,boundedSkillTask,sendSkillReceipt}=load('features/teams/teams-skill-jobs.ts');
 await sendSkillReceipt(()=>{throw Error('notification failed');},'accepted',{deadline:Date.now()+1000});
 await sendSkillReceipt(()=>{throw Error('must not send outside budget');},'accepted',{deadline:Date.now()-1});
 let finish,usageCount=0;work=()=>new Promise(resolve=>finish=resolve);const sent=[],p={...props('success',async value=>sent.push(value)),onCompleted:async()=>{usageCount++;}};
 const receipt=await acceptTeamsSkillJob(p);assert.ok(receipt.includes('受け付け'));assert.equal(sent.length,0,'ACK before worker starts');
 await settle();assert.equal(executions,1);
 await acceptTeamsSkillJob({...p,activityId:'retry-with-new-id'});assert.equal(executions,1);
 finish({text:'FINAL REPORT'});await settle();assert.equal(sent.filter(v=>v==='FINAL REPORT').length,1);assert.equal([...rows.values()].at(-1).status,'succeeded');
 await acceptTeamsSkillJob({...p,activityId:'retry-after-send'});await settle();assert.equal(executions,1);
 assert.equal(usageCount,1,'Completion statistics are recorded once after successful delivery');
 const failed=[];work=async()=>{throw Error('private details must not be logged');};await acceptTeamsSkillJob(props('failure',async v=>failed.push(v)));await settle();assert.equal([...rows.values()].at(-1).status,'failed');assert.ok(failed.some(v=>v.includes('完了できません')));
 const partial=[];work=async()=>({text:table});await acceptTeamsSkillJob(props('partial',async v=>{partial.push(v);if(typeof v==='string'&&v.startsWith('（2/'))throw error(503);}));await settle();assert.equal([...rows.values()].at(-1).status,'delivery_uncertain');assert.ok(partial.some(v=>v.includes('送信完了を確認できません')));assert.equal(partial.filter(v=>v.startsWith('（1/')).length,1);
 const realNow=Date.now;let now=realNow();Date.now=()=>now;
 const longSent=[];work=async()=>{now+=210000;return {text:table};};
 await acceptTeamsSkillJob(props('long-generation',async value=>{longSent.push(value);now+=15000;}));await settle();Date.now=realNow;
 const longJob=[...rows.values()].at(-1);assert.equal(longJob.status,'succeeded','A long valid generation receives a fresh delivery window');assert.ok(longSent.length>1);assert.ok(longJob.deadline>=now);
 work=async()=>({text:'cold connection result'});createDelay=1200;
 const cold=await acceptTeamsSkillJob(props('cold-create',async()=>{}));assert.ok(cold.includes('受け付け'));createDelay=0;await settle();
 await assert.rejects(acceptTeamsSkillJob({...props('expired-budget',async()=>{}),budget:{deadline:Date.now()-1}}),/receipt_timeout/);
 const before=executions;createFails=true;await assert.rejects(acceptTeamsSkillJob(props('store-failure',async()=>{})));createFails=false;assert.equal(executions,before);
 await assert.rejects(acceptTeamsSkillJob({...p,value:{feature:'ac.skill',token:'foreign'}}));assert.equal(executions,before);
 process.env.TEAMS_SKIP_AUTH='true';await assert.rejects(acceptTeamsSkillJob(props('skip-auth',async()=>{})));process.env.TEAMS_SKIP_AUTH='false';
 const restart=[...rows.values()][0];restart.status='running';restart.deadline=Date.now()-1;rows.set(restart.userId+restart.id,restart);
 assert.ok((await acceptTeamsSkillJob(p)).includes('中断'));assert.equal(executions,before);
 await assert.rejects(boundedSkillTask(new Promise(()=>{}),1),/timeout/);
 const {trackSkillReport,finalizeSkillReport,SKILL_OUTPUT_LIMIT_NOTE,SKILL_CONTENT_FILTER_NOTE,skillReportReasoningOptions}=load('features/skills/execution/skill-report-output.ts');
 delete process.env.SKILL_REPORT_REASONING_EFFORT;assert.deepEqual(skillReportReasoningOptions(),{});process.env.SKILL_REPORT_REASONING_EFFORT='low';assert.deepEqual(skillReportReasoningOptions(),{reasoning_effort:'low'});delete process.env.SKILL_REPORT_REASONING_EFFORT;
 const runner=new EventEmitter();trackSkillReport(runner,'参照したSkill: fixture v1','web');runner.emit('finalChatCompletion',{choices:[{finish_reason:'length'}],usage:{completion_tokens:12000,completion_tokens_details:{reasoning_tokens:2000}}});
 const final=finalizeSkillReport(runner,'途中');assert.ok(final.includes(SKILL_OUTPUT_LIMIT_NOTE));assert.ok(final.includes('fixture v1'));assert.equal(finalizeSkillReport(runner,final),final);
 const filtered=finalizeSkillReport(runner,'本文',{choices:[{finish_reason:'content_filter'}]});assert.ok(filtered.includes(SKILL_CONTENT_FILTER_NOTE));assert.ok(!filtered.includes(SKILL_OUTPUT_LIMIT_NOTE),'Teams uses returned completion rather than an older event');assert.equal(finalizeSkillReport(runner,filtered,{choices:[{finish_reason:'content_filter'}]}),filtered);
 const {OpenAIStream}=load('features/chat-page/chat-services/chat-api/open-ai-stream.ts');
 const web=new EventEmitter();trackSkillReport(web,'参照したSkill: fixture v1','web');
 const stream=OpenAIStream({runner:web,chatThread:{id:'fixture-chat'},finalizeContent:content=>finalizeSkillReport(web,content)});
 const reading=new Response(stream).text();web.emit('finalChatCompletion',{choices:[{finish_reason:'length'}]});web.emit('finalContent','途中');
 const sse=await reading;assert.ok(sse.includes(SKILL_OUTPUT_LIMIT_NOTE));assert.ok(saved.some(v=>v.role==='assistant'&&v.content.includes(SKILL_OUTPUT_LIMIT_NOTE)),'Web persists exactly the truncation notice it displays');
 console.log('PASS early ACK, durable dedup, no replay, failure/partial delivery, bounded Markdown, output finish reason and Web persistence');
})().catch(error=>{console.error(error);process.exitCode=1;});
