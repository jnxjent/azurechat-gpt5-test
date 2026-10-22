const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..');
const external=Module.createRequire(path.join(source,'package.json')),ts=external('typescript'),cache=new Map(),persisted=[],errors=[];
let nextId=0;
const stubs={
 '@/features/common/util':{uniqueId:()=>`local-${++nextId}`},
 '@/features/globals/global-message-store':{showError:e=>errors.push(String(e))},
 '@/features/theme/theme-config':{AI_NAME:'Assistant',NEW_CHAT_NAME:'New Chat'},
 '../common/navigation-helpers':{RevalidateCache:()=>{}},
 '../ui/chat/chat-input-area/input-image-store':{InputImageStore:{Reset:()=>{}}},
 '../ui/chat/chat-input-area/image-form-data':{prepareImageFormData:()=>{},readImageFormData:async()=>''},
 './chat-input/speech/use-text-to-speech':{textToSpeechStore:{speak:()=>{}}},
 './chat-input/use-chat-input-dynamic-height':{ResetInputRows:()=>{}},
 './chat-services/chat-thread-service':{UpdateChatTitle:async()=>{},AddExtensionToChatThread:async()=>{},RemoveExtensionFromChatThread:async()=>{}},
};
function load(relative){
 const file=path.resolve(source,relative);if(cache.has(file))return cache.get(file);
 const m=new Module(file);m.filename=file;m.require=id=>{
  if(id==='server-only')return {};
  if(stubs[id])return stubs[id];
  if(id.endsWith('/chat-message-service'))return {CreateChatMessage:async record=>{persisted.push(record);return {status:'OK',response:record};}};
  if(id.startsWith('@/'))return load(id.slice(2)+'.ts');
  if(id.startsWith('.'))return load(path.resolve(path.dirname(file),id+'.ts'));
  return external(id);
 };
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
 cache.set(file,m.exports);return m.exports;
}
async function main(){
 const {chatStore}=load('features/chat-page/chat-store.tsx');
 const {salesforceTextStream}=load('features/common/services/salesforce-clarification-stream.ts');
 const {OpenAIStream}=load('features/chat-page/chat-services/chat-api/open-ai-stream.ts');
 const replies=['有効ユーザーは165名です。','取引先は47,846件です。','請求先は6,329件です。','対象は全取引先です。','部下の取引先は11,222件です。','部下の取引先は11,222件です。'];
 let cursor=0;
 global.fetch=async()=>new Response(OpenAIStream({runner:salesforceTextStream(replies[cursor++],new AbortController().signal),chatThread:{id:'collision-test'}}));
 chatStore.initChatSession({userName:'test',messages:[],chatThread:{id:'collision-test',name:'Existing'}});
 const observed=[];
 for(const question of ['有効ユーザの数を教えて','取引先の登録件数を教えて','そのうち請求先にチェックがある件数は？','全取引先を対象に数えた？','私の部下の取引先の件数は？','もう一度教えて']){
  await chatStore.submitText(question);
  observed.push({question,assistantCount:chatStore.messages.filter(m=>m.role==='assistant').length,
    assistantMessages:chatStore.messages.filter(m=>m.role==='assistant').map(m=>({id:m.id,content:m.content}))});
 }
 assert.equal(errors.length,0);
 assert.equal(persisted.length,replies.length,'server persists every reply');
 for(let i=0;i<observed.length;i++){
  assert.equal(observed[i].assistantCount,i+1,'every turn adds a separate assistant message');
  assert.deepEqual(observed[i].assistantMessages.map(m=>m.content),replies.slice(0,i+1),'previous answers remain unchanged');
  assert.equal(new Set(observed[i].assistantMessages.map(m=>m.id)).size,i+1,'reply IDs are unique even for identical answers');
 }
 assert.deepEqual(chatStore.messages.map(m=>m.role),replies.flatMap(()=>['user','assistant']));
 assert.deepEqual(persisted.map(m=>m.content),replies);
 const snapshot={orgId:'00D000000000001AAA',userId:'005000000000001AAA',retrievedAt:'2026-10-21T03:00:00.000Z'};
 global.fetch=async()=>{
  const runner=salesforceTextStream('本人権限の検索結果です。',new AbortController().signal);
  Object.defineProperty(runner,'salesforceSnapshot',{value:snapshot});
  return new Response(OpenAIStream({runner,chatThread:{id:'collision-test'}}));
 };
 await chatStore.submitText('本人接続の結果を保存');
 const last=chatStore.messages.filter(m=>m.role==='assistant').at(-1);
 assert.ok(last.content.includes(snapshot.retrievedAt)&&last.content.includes('非表示'));
 assert.deepEqual(persisted.at(-1).salesforceSnapshot,snapshot);
 console.log('PASS Salesforce multi-turn replies: real SSE and client store preserve all six answers, including repeated text');
 console.log('PASS personal snapshot: server source identity and timestamp are persisted and shown in final SSE');
}
module.exports=main();
if(require.main===module)module.exports.catch(error=>{console.error(error.stack);process.exitCode=1;});
