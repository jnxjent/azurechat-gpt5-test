const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
let authenticated=true, captured, calls=0, failure=false, finish='stop', sharedFailure=false;
let queued=[];
const draft={title:'訪問前ブリーフィング',description:'顧客訪問の準備',content:'# 目的\n会社名を確認し、利用可能な情報を整理する。'};
let output={reply:'最初の案を作りました。',action:'draft',draft,basedOn:null};
let own=[{id:'skill-'+'a'.repeat(64),title:'営業進捗管理',description:'営業所ごとの商談進捗を週次で整理',content:'# 営業進捗\n本文',enabled:true,shared:false,version:3,updatedAt:'2026-10-01'}];
let shared=[{ref:'b'.repeat(32),title:'週ミーティング',description:'週次の営業ミーティング資料を作る',content:'# 週ミーティング\n本文',ownerName:'山田',updatedAt:'2026-10-02'}];
const stubs={
  'server-only':{},
  '@/features/auth-page/helpers':{async getCurrentUser(){if(!authenticated)throw Error('User not found');return {email:'owner@example.test',name:'Owner'};}},
  '@/features/common/services/salesforce-access':{isSalesforceAllowedEmail:email=>email==='owner@example.test'},
  '@/features/skills/skill-service':{async listUserSkills(){return own;},async listSharedSkills(){if(sharedFailure)throw Error('cross partition down');return shared;}},
  '@/features/common/services/openai':{OpenAIInstance:()=>({chat:{completions:{async create(body,options){
    calls++;captured={body,options};if(failure)throw Error('upstream secret=private credential');
    return {choices:[{finish_reason:finish,message:{content:JSON.stringify(queued.length ? queued.shift() : output)}}]};
  }}}})},
};
const cache=new Map();
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
 const module={exports:{}};cache.set(file,module);
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 new Function('require','module','exports',source)(id=>{
  if(Object.hasOwn(stubs,id))return stubs[id];
  if(id.startsWith('./'))return load(path.resolve(path.dirname(file),id+'.ts'));
  if(id.startsWith('@/features/skills/'))return load('features/skills/'+id.split('/').at(-1)+'.ts');
  // Fail if generation starts touching chat history, memory, credentials or tools.
  if(id.startsWith('@/'))throw Error('Forbidden generator dependency '+id);
  return require(id);
 },module,module.exports);return module.exports;
}
const rules=load('features/skills/skill-generator-rules.ts');
const api=load('app/(authenticated)/api/skills/generate/route.ts');
const opening=rules.generatorOpening(['営業進捗管理','週ミーティング','商談促進','予実分析'],4);
const conversation=(...turns)=>[{role:'assistant',content:opening},...turns.map((content,i)=>({role:i%2?'assistant':'user',content}))];
const request=body=>new Request('http://local.test/api/skills/generate',{method:'POST',body:JSON.stringify(body)});
const envKeys=['AZURE_OPENAI_API_KEY','AZURE_OPENAI_API_DEPLOYMENT_NAME','SF_EXTENSION_ID','BRAVE_SUBSCRIPTION_TOKEN'];
const before=envKeys.map(key=>process.env[key]);
async function main(){
 process.env.AZURE_OPENAI_API_KEY='secret-do-not-return';process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME='mock';process.env.SF_EXTENSION_ID='id';delete process.env.BRAVE_SUBSCRIPTION_TOKEN;
 // Opening message mirrors the requested guidance and names existing Skills.
 assert.ok(opening.startsWith('どんなスキルにするか教えてください。'));
 assert.ok(opening.includes('「営業進捗管理」「週ミーティング」「商談促進」など4件'));
 assert.ok(!rules.generatorOpening([],0).includes('登録されています'),'no catalog sentence without Skills');
 // Validation.
 assert.throws(()=>rules.validateGeneratorInput({messages:[]}),/会話/);
 assert.throws(()=>rules.validateGeneratorInput({messages:conversation()}),/メッセージを入力/,'last message must be from the user');
 assert.throws(()=>rules.validateGeneratorInput({messages:conversation('おまかせ')}),/目的/);
 assert.throws(()=>rules.validateGeneratorInput({messages:conversation('あ'.repeat(700))}),/2,000/);
 assert.throws(()=>rules.validateGeneratorInput({messages:[{role:'system',content:'x'}]}),/形式/);
 assert.throws(()=>rules.validateGeneratorInput({messages:Array.from({length:21},()=>({role:'user',content:'a'}))}),/長く/);
 // Lexical preselection finds the related Skill and ignores unrelated ones.
 const catalog=[{ref:'1',scope:'own',title:'営業進捗管理',description:'営業所ごとの商談進捗を週次で整理',content:''},{ref:'2',scope:'own',title:'経費精算チェック',description:'領収書と申請内容の照合',content:''}];
 assert.deepEqual(rules.similarCandidates('営業所ごとに商談の進捗を毎週まとめたい',catalog).map(c=>c.ref),['1']);
 assert.deepEqual(rules.similarCandidates('',catalog),[]);

 authenticated=false;assert.equal((await api.POST(request({messages:conversation('訪問前の準備')}))).status,401);assert.equal(calls,0);authenticated=true;
 assert.equal((await api.POST(new Request('http://local.test',{method:'POST',body:'not json'}))).status,400);
 assert.equal((await api.POST(request({messages:[]}))).status,400);assert.equal(calls,0);
 assert.equal((await api.POST(request({messages:conversation('x'),padding:'x'.repeat(81000)}))).status,400);assert.equal(calls,0);

 // First turn with a clear purpose returns a draft immediately.
 let result=await api.POST(request({messages:conversation('営業所ごとに商談の進捗を毎週まとめたい'),email:'attacker@example.test',availableConfiguration:{slack:'available'}}));
 assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'private, no-store');
 let data=await result.json();assert.equal(data.reply,output.reply);assert.equal(data.draft.title,draft.title);assert.equal(data.draft.shared,false);assert.equal(data.basedOn,undefined);
 let payload=JSON.parse(captured.body.messages[1].content);
 assert.equal(payload.userTurns,1);
 assert.equal(payload.availableConfiguration.salesforce,'configured_for_user_not_connection_tested');
 assert.equal(payload.availableConfiguration.slack,'not_integrated');assert.equal(payload.availableConfiguration.web,'not_configured');
 assert.deepEqual(payload.catalog.map(s=>s.title),['営業進捗管理','週ミーティング'],'catalog comes from the server, own and shared');
 assert.equal(payload.candidates[0].title,'営業進捗管理');assert.ok(payload.candidates[0].content.includes('本文'));
 assert.ok(payload.catalog.every(s=>!('ref' in s)&&!('content' in s)),'the catalog carries titles only; full text is limited to candidates');
 assert.ok(captured.body.messages[0].content.includes('fewest exchanges'));
 assert.equal(captured.body.tools,undefined);assert.equal(captured.options.timeout,60000);assert.equal(captured.options.maxRetries,0);
 assert.ok(captured.options.signal instanceof AbortSignal);
 assert.ok(!JSON.stringify(captured.body).includes('secret-do-not-return'));

 // Basing on an own Skill returns its id/version for an update.
 output={reply:'既存の「営業進捗管理」を改善しました。',action:'draft',draft:{...draft,title:'営業進捗管理'},basedOn:own[0].id};
 data=await (await api.POST(request({messages:conversation('営業所ごとに商談の進捗を毎週まとめたい')}))).json();
 assert.deepEqual(data.basedOn,{ref:own[0].id,scope:'own',title:'営業進捗管理',id:own[0].id,version:3,shared:false});
 // Basing on another employee's Skill never exposes its storage key.
 output={reply:'山田さんの公開Skillをもとにしました。',action:'draft',draft,basedOn:'shared-'+shared[0].ref};
 data=await (await api.POST(request({messages:conversation('週次の営業ミーティング資料を作りたい')}))).json();
 assert.deepEqual(data.basedOn,{ref:'shared-'+shared[0].ref,scope:'shared',title:'週ミーティング',ownerName:'山田'});
 // A fabricated base outside the candidates is dropped.
 output={reply:'案です。',action:'draft',draft,basedOn:'skill-'+'f'.repeat(64)};
 data=await (await api.POST(request({messages:conversation('全く別の仕事')}))).json();assert.equal(data.basedOn,undefined);

 // A clarifying question has no draft; after two user turns a draft is required.
 output={reply:'どんな成果物にしますか？',action:'ask',draft:null,basedOn:null};
 data=await (await api.POST(request({messages:conversation('何か作りたい')}))).json();assert.equal(data.draft,undefined);assert.equal(data.reply,'どんな成果物にしますか？');
 output={reply:'案を作りました。',action:'ask',draft,basedOn:null};
 data=await (await api.POST(request({messages:conversation('何か作りたい','どんな成果物にしますか？','週次の報告書')}))).json();
 assert.equal(data.draft.title,draft.title,'turn 2 forces a draft even if the model hesitates');
 assert.equal(JSON.parse(captured.body.messages[1].content).userTurns,2);

 // Revisions send the current draft.
 output={reply:'表形式に変更しました。',action:'draft',draft:{...draft,content:draft.content+'\n表形式'},basedOn:null};
 result=await api.POST(request({messages:conversation('訪問前の準備','案です','表形式に変更して'),draft}));assert.equal(result.status,200);
 payload=JSON.parse(captured.body.messages[1].content);assert.equal(payload.existingDraft.content,draft.content);

 // Required drafts retry exactly once, then fail safely instead of returning another question.
 const missing={reply:'Please clarify',action:'ask',draft:null,basedOn:null};
 const secondTurn={messages:conversation('report','which report?','weekly report')};
 let startCalls=calls;queued=[missing,{reply:'draft ready',action:'draft',draft,basedOn:null}];
 result=await api.POST(request(secondTurn));assert.equal(result.status,200);assert.ok((await result.json()).draft);assert.equal(calls-startCalls,2);
 assert.ok(captured.body.messages[0].content.includes('previous response omitted'));
 startCalls=calls;queued=[missing,missing];result=await api.POST(request(secondTurn));assert.equal(result.status,503);assert.equal(calls-startCalls,2);
 // A pinned own base survives model omissions and cannot silently advance its version.
 own[0].shared=true;
 output={reply:'draft ready',action:'draft',draft,basedOn:own[0].id};
 const original=await(await api.POST(request({messages:conversation(own[0].title)}))).json();
 assert.equal(original.basedOn.shared,true);
 output={reply:'revised',action:'draft',draft,basedOn:null};
 const revision={messages:conversation(own[0].title,'draft','change format'),draft,basedOn:original.basedOn};
 data=await(await api.POST(request(revision))).json();assert.deepEqual(data.basedOn,original.basedOn);
 own[0].version=4;startCalls=calls;
 result=await api.POST(request(revision));assert.equal(result.status,409);assert.equal(calls,startCalls,'conflict must be detected before generation');
 own[0].version=3;
 // Explicitly detaching the base permits a new draft without an update target.
 data=await(await api.POST(request({...revision,createNew:true}))).json();assert.equal(data.basedOn,undefined);
 // Client retains original provenance and explicit publication edits across revisions.
 const retained=rules.retainGeneratorBase(null,original.basedOn,false,false);
 assert.equal(retained.publish,true);
 const next=rules.retainGeneratorBase(retained.basedOn,undefined,false,false);
 assert.deepEqual(next.basedOn,original.basedOn);assert.equal(next.publish,false);
 assert.equal(rules.retainGeneratorBase(null,original.basedOn,false,true).basedOn,null);
 assert.throws(()=>rules.validateGeneratorInput({...revision,basedOn:{...original.basedOn,version:0}}));

 // Explicit HTML requirements survive generation instead of being rewritten as Markdown.
 const htmlDraft={...draft,content:'# 出力形式\nHTMLレポートを単一のhtmlコードブロックで返す。埋め込みCSSを使い、外部通信しない。'};
 output={reply:'HTMLレポートのSkill案です。',action:'draft',draft:htmlDraft,basedOn:null};
 data=await(await api.POST(request({messages:conversation('訪問前レポートをHTMLで出力するSkillを作って')}))).json();
 assert.equal(data.draft.content,htmlDraft.content);
 assert.ok(captured.body.messages[0].content.includes('HTML output is supported'));
 assert.ok(JSON.parse(captured.body.messages[1].content).availableConfiguration.output.includes('HTML'));
 // Shared catalog failure does not block generation.
 sharedFailure=true;assert.equal((await api.POST(request({messages:conversation('訪問前の準備')}))).status,200);sharedFailure=false;
 finish='length';assert.equal((await api.POST(request({messages:conversation('訪問前の準備')}))).status,503);finish='stop';
 output={reply:'',action:'draft',draft:{title:'invalid',content:'あ'.repeat(4001)}};assert.equal((await api.POST(request({messages:conversation('訪問前の準備')}))).status,503);
 failure=true;result=await api.POST(request({messages:conversation('訪問前の準備')}));assert.equal(result.status,503);assert.ok(!(await result.text()).includes('private credential'));failure=false;
 delete process.env.AZURE_OPENAI_API_KEY;const noConfigCalls=calls;assert.equal((await api.POST(request({messages:conversation('訪問前の準備')}))).status,503);assert.equal(calls,noConfigCalls);
 console.log('PASS SkillGenerator: conversational turns, opening guidance, early draft, server-side own/shared catalog, safe basedOn, bounded input/output, no tools or storage writes, safe failures');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>envKeys.forEach((key,i)=>{if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];}));
