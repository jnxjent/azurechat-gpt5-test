const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
let user='owner',etag=0;const rows=new Map();const key=(id,owner)=>JSON.stringify([id,owner]);
rows.set(key('thread','owner'),{id:'thread',userId:'owner',type:'CHAT_THREAD',isDeleted:false});
const container={item(id,owner){return {async read(){const row=rows.get(key(id,owner));if(!row)throw {code:404};return {resource:structuredClone(row)};},async replace(row,options){const prior=rows.get(key(id,owner));if(!prior||prior._etag!==options.accessCondition.condition)throw {code:412};rows.set(key(id,owner),{...structuredClone(row),_etag:String(++etag)});}};},items:{async create(row){const k=key(row.id,row.userId);if(rows.has(k))throw {code:409};rows.set(k,{...structuredClone(row),_etag:String(++etag)});}}};
const mod={exports:{}};const source=fs.readFileSync(path.join(__dirname,'../features/common/services/salesforce-opportunity-context.ts'),'utf8');
new Function('require','module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(id=>id==='server-only'?{}:id==='./cosmos'?{HistoryContainer:()=>container}:id==='@/features/auth-page/helpers'?{userHashedId:async()=>user}:require(id),mod,mod.exports);
const {readOpportunityContext:read,saveOpportunityContext:save}=mod.exports;
(async()=>{
 const empty=await read('thread');assert.equal(empty.token,undefined);await save(empty,'signed-gateway-scope');
 const persisted=await read('thread');assert.equal(persisted.token,'signed-gateway-scope');assert.equal(rows.get(key(persisted.id,'owner')).ttl,1800);
 await assert.rejects(()=>save(empty,'concurrent-create'),e=>e.code===409);
 await save(persisted,'new-scope');await assert.rejects(()=>save(persisted,'stale-write'),e=>e.code===412);
 const latest=await read('thread');user='other';await assert.rejects(()=>read('thread'));await assert.rejects(()=>save(latest,'stolen-scope'));
 user='owner';await save(latest,undefined);assert.equal((await read('thread')).token,undefined);
 await assert.rejects(async()=>save(await read('thread'),'x'.repeat(7501)));
 rows.get(key('thread','owner')).isDeleted=true;await assert.rejects(()=>read('thread'));
 console.log('PASS persisted Opportunity scope: owned thread, cross-user isolation, TTL, independent reads, clear, length limits and concurrent-write rejection');
})().catch(error=>{console.error(error);process.exitCode=1;});
