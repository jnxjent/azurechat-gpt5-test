const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),cache=new Map(),documents=new Map();
const principal='11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
let messages=[],allowed=true,networkFails=false,requests=0,aiCalls=0,etag=0;
const owner='test-owner',thread='test-thread';
const user={email:'a@example.com',salesforcePrincipal:principal};
const container={items:{query(spec,options){
 if(options)assert.equal(options.partitionKey,owner);
 const p=Object.fromEntries(spec.parameters.map(x=>[x.name,x.value]));assert.equal(p['@user']??p['@userId'],owner);
 return {fetchAll:async()=>({resources:p['@type']==='CHAT_THREAD'?[{id:thread}]:p['@type']==='USER_CANVAS'?[...documents.values()]:spec.query.includes('root r')?messages:spec.query.includes('IS_DEFINED')?messages.filter(m=>m.salesforceSnapshot):messages})};
},async create(item){documents.set(item.id,{...item,_etag:String(++etag)});}},item(id,userId){assert.equal(userId,owner);return {
 async read(){if(!documents.has(id))throw {code:404};return {resource:structuredClone(documents.get(id))};},
 async replace(item){documents.set(id,{...item,_etag:String(++etag)});}
};}};
const stubs={
 'server-only':{},
 '@/features/auth-page/helpers':{userHashedId:async()=>owner,getCurrentUser:async()=>user},
 '@/features/common/services/cosmos':{HistoryContainer:()=>container},
 '@/features/common/services/openai':{OpenAIInstance:()=>({chat:{completions:{create:async()=>{aiCalls++;return {choices:[{finish_reason:'stop',message:{content:'edited'}}]};}}}})},
 '@/features/common/util':{uniqueId:()=>require('node:crypto').randomUUID()},
 '@/features/chat-page/chat-services/models':{CHAT_THREAD_ATTRIBUTE:'CHAT_THREAD',MESSAGE_ATTRIBUTE:'CHAT_MESSAGE'},
};
function load(relative){
 const file=path.resolve(root,relative);if(cache.has(file))return cache.get(file);
 if(file===path.resolve(root,'features/common/services/cosmos.ts'))return stubs['@/features/common/services/cosmos'];
 const mod={exports:{}};cache.set(file,mod.exports);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 new Function('require','module','exports',code)(id=>stubs[id]??(id.startsWith('@/')?load(id.slice(2)+'.ts'):id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id)),mod,mod.exports);
 return mod.exports;
}
global.fetch=async(url,options)=>{
 requests++;if(networkFails)throw Error('offline');
 assert.equal(new URL(url).pathname,'/api/sf/revalidate');assert.equal(options.method,'POST');
 assert.equal(options.headers['X-User-Email'],user.email);assert.equal(options.headers['X-Chat-Thread-Id'],thread);
 assert.ok(options.headers['X-AC-Identity']&&options.headers['X-AC-Signature']);
 return new Response(JSON.stringify({ok:true,allowed}),{headers:{'Content-Type':'application/json','X-SF-Connection-Mode':process.env.SF_PERSONAL_AUTH_METHOD==='oauth'?'personal-oauth':'personal-jwt','X-AC-Principal':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
};
async function main(){
 process.env.SF_PERSONAL_MODE='true';process.env.SF_PERSONAL_SNAPSHOT_POLICY='strict';process.env.SF_PERSONAL_SIGNING_KEY='x'.repeat(40);process.env.SF_GATEWAY_BASE_URL='https://legacy.example.com';process.env.SF_PERSONAL_GATEWAY_BASE_URL='https://gateway.example.com';process.env.SF_PERSONAL_USERS_JSON=JSON.stringify([{principal,email:user.email}]);
 const access=load('features/common/services/salesforce-history-access.ts');
 const make=(content,sf=false)=>{
  const m={id:'message',createdAt:new Date(),isDeleted:false,threadId:thread,userId:owner,role:'assistant',name:'AI',type:'CHAT_MESSAGE',content,...(sf?{salesforceSnapshot:{orgId:'00D000000000001AAA',userId:'005000000000001AAA',retrievedAt:'2026-10-21T00:00:00Z',proof:'signed-test-proof'}}:{})};
  m.historyAccess=access.sealHistoryMessage(m);return m;
 };
 messages=[make('private sf answer',true)];
 assert.equal((await access.filterSalesforceHistory(messages,thread,owner))[0].content,'private sf answer');
 const firstRequests=requests;allowed=false;
 const hidden=(await access.filterSalesforceHistory(messages,thread,owner))[0];
 assert.equal(hidden.content,access.RESTRICTED_HISTORY);assert.ok(!JSON.stringify(hidden).includes('private sf answer'));assert.ok(requests>firstRequests,'permissions are rechecked after a prior success');
 const historyService=load('features/chat-page/chat-services/chat-message-service.ts');
 let history=await historyService.FindAllChatMessagesForCurrentUser(thread);assert.equal(history.status,'OK');assert.equal(history.response[0].content,access.RESTRICTED_HISTORY);
 allowed=true;history=await historyService.FindTopChatMessagesForCurrentUser(thread);assert.equal(history.status,'OK');assert.equal(history.response[0].content,'private sf answer');
 allowed=true;networkFails=true;assert.equal((await access.filterSalesforceHistory(messages,thread,owner))[0].content,access.RESTRICTED_HISTORY);networkFails=false;
 const citation={id:'citation',content:{document:{pageContent:'sharepoint'}},userId:owner,type:'CHAT_CITATION'};
 citation.nonSalesforceSeal=access.sealNonSalesforceCitation(citation);assert.ok(access.validNonSalesforceCitation(citation));assert.ok(!access.validNonSalesforceCitation({...citation,content:'tampered'}));
 const valid=make('visible',false);messages=[valid];
 assert.equal((await access.filterSalesforceHistory([{...valid,content:'tampered secret'}],thread,owner))[0].content,access.RESTRICTED_HISTORY);
 messages=[{...valid,historyAccess:undefined}];assert.equal((await access.filterSalesforceHistory(messages,thread,owner))[0].content,access.RESTRICTED_HISTORY);
 const legacy=messages[0],indexPath=path.join(require('node:os').tmpdir(),'sf-index-'+require('node:crypto').randomUUID()+'.json');
 const prepare=require('./prepare-salesforce-legacy-index.cjs').prepare;
 assert.throws(()=>prepare([legacy],{}));
 const index=prepare([legacy],{[owner+'/'+legacy.id]:'non_sf'});fs.writeFileSync(indexPath,JSON.stringify(index));process.env.SF_PERSONAL_LEGACY_INDEX_PATH=indexPath;
 try {assert.equal((await access.filterSalesforceHistory([legacy],thread,owner))[0].content,'visible','reviewed legacy non-SF survives');
 assert.equal((await access.filterSalesforceHistory([{...legacy,content:'modified'}],thread,owner))[0].content,access.RESTRICTED_HISTORY,'migration is content bound');} finally {fs.unlinkSync(indexPath);delete process.env.SF_PERSONAL_LEGACY_INDEX_PATH;}

 const aggregate=make('aggregate',true);aggregate.id='aggregate';delete aggregate.salesforceSnapshot.proof;aggregate.historyAccess=access.sealHistoryMessage(aggregate);messages=[aggregate];
 assert.equal(await access.canReadSalesforceThread(thread,owner,['aggregate']),false,'unverifiable aggregates fail closed');
 messages=[aggregate,valid];let mixed=await access.filterSalesforceHistory(messages,thread,owner);assert.equal(mixed[0].content,access.RESTRICTED_HISTORY);assert.equal(mixed[1].content,'visible','unrelated messages remain visible');
 user.email='other@example.com';user.salesforcePrincipal='other';assert.equal((await access.filterSalesforceHistory(messages,thread,owner))[0].content,'aggregate','unselected users remain unchanged');user.email='a@example.com';user.salesforcePrincipal=principal;
 const beforeList=requests;await access.protectedThreadIds(owner);assert.equal(requests,beforeList,'title metadata never queries Salesforce');

 const api=load('app/(authenticated)/api/canvas/route.ts'),rewrite=load('app/(authenticated)/api/canvas/rewrite/route.ts');
 const doc={threadId:thread,title:'private title',content:'private table',sourceContent:'private sf answer',unit:'円',period:'2026年',source:'Salesforce',chartType:'bar',tableIndex:0,valueColumn:1,version:0};
 const put=body=>api.PUT(new Request('http://localhost/api/canvas',{method:'PUT',body:JSON.stringify(body)}));
 messages=[make('private sf answer',true)];allowed=true;
 let result=await put(doc);assert.equal(result.status,200);let saved=(await result.json()).item;
 result=await api.GET(new Request('http://localhost/api/canvas?threadId='+thread));assert.equal(result.status,200);
 result=await put({...saved,content:'second private version'});assert.equal(result.status,200);saved=(await result.json()).item;
 result=await api.GET(new Request('http://localhost/api/canvas?threadId='+thread+'&history=1'));assert.equal((await result.json()).history.length,1);
 allowed=false;
 result=await api.GET(new Request('http://localhost/api/canvas?threadId='+thread+'&history=1'));assert.equal(result.status,403);assert.ok(!(await result.text()).includes('private table'));
 const listRequests=requests;result=await api.GET(new Request('http://localhost/api/canvas?list=1'));assert.equal(requests,listRequests,'Canvas lists do not requery Salesforce');const library=(await result.json()).items;assert.equal(library.length,1);assert.ok(!JSON.stringify(library).includes('private title'));
 result=await put(saved);assert.equal(result.status,403);
 result=await rewrite.POST(new Request('http://localhost/api/canvas/rewrite',{method:'POST',body:JSON.stringify({document:saved,instruction:'edit'})}));assert.equal(result.status,403);assert.equal(aiCalls,0,'blocked content must never reach the LLM');
 allowed=true;
 const stored=[...documents.values()][0];delete stored.canvasAccessSeal;
 result=await api.GET(new Request('http://localhost/api/canvas?threadId='+thread));assert.equal(result.status,403,'legacy or forged Canvas is not trusted');
 delete process.env.SF_PERSONAL_MODE;assert.equal((await access.filterSalesforceHistory(messages,thread,owner))[0].content,'private sf answer');
 console.log('PASS strict history/Canvas: current access, revocation, outage, tampering, legacy data, lists, history, PUT and rewrite denied without exposing content');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
