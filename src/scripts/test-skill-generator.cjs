const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
let authenticated=true, captured, calls=0, failure=false, finish='stop';
let output={title:'訪問前ブリーフィング',description:'顧客訪問の準備',content:'# 目的\n会社名を確認し、利用可能な情報を整理する。'};
const stubs={
  'server-only':{},
  '@/features/auth-page/helpers':{async getCurrentUser(){if(!authenticated)throw Error('User not found');return {email:'owner@example.test'};}},
  '@/features/common/services/salesforce-access':{isSalesforceAllowedEmail:email=>email==='owner@example.test'},
  '@/features/common/services/openai':{OpenAIInstance:()=>({chat:{completions:{async create(body,options){
    calls++;captured={body,options};if(failure)throw Error('upstream secret=private credential');
    return {choices:[{finish_reason:finish,message:{content:JSON.stringify(output)}}]};
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
  // Fail if generation starts touching storage, history, credentials or tools.
  if(id.startsWith('@/'))throw Error('Forbidden generator dependency '+id);
  return require(id);
 },module,module.exports);return module.exports;
}
const rules=load('features/skills/skill-generator-rules.ts');
const api=load('app/(authenticated)/api/skills/generate/route.ts');
const answers=['訪問前の準備','会社名','SalesforceとSlackとWeb','数値を推測しない','表と箇条書き'];
const request=body=>new Request('http://local.test/api/skills/generate',{method:'POST',body:JSON.stringify(body)});
const envKeys=['AZURE_OPENAI_API_KEY','AZURE_OPENAI_API_DEPLOYMENT_NAME','SF_EXTENSION_ID','BRAVE_SUBSCRIPTION_TOKEN'];
const before=envKeys.map(key=>process.env[key]);
async function main(){
 process.env.AZURE_OPENAI_API_KEY='secret-do-not-return';process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME='mock';process.env.SF_EXTENSION_ID='id';delete process.env.BRAVE_SUBSCRIPTION_TOKEN;
 assert.equal(rules.GENERATOR_QUESTIONS.length,5);
 assert.deepEqual(rules.toggleGeneratorOption(['Salesforce'],'Web'),['Salesforce','Web']);
 assert.deepEqual(rules.toggleGeneratorOption(['Salesforce','Web'],'Salesforce'),['Web']);
 assert.deepEqual(rules.toggleGeneratorOption(['Salesforce','Web'],'入力した情報だけ'),['入力した情報だけ']);
 assert.deepEqual(rules.toggleGeneratorOption(['おまかせ'],'会社名'),['会社名']);
 assert.equal(rules.combineGeneratorAnswer(['Salesforce','Web'],'直近1年'),'Salesforce、Web\n補足：直近1年');
 assert.throws(()=>rules.validateGeneratorInput({answers:answers.slice(0,4)}),/5つ/);
 assert.throws(()=>rules.validateGeneratorInput({answers:['おまかせ',...answers.slice(1)]}),/目的/);
 assert.throws(()=>rules.validateGeneratorInput({answers:['あ'.repeat(401),...answers.slice(1)]}),/1,200/);
 assert.throws(()=>rules.validateGeneratorInput({answers,revision:'変更'}),/修正/);
 authenticated=false;assert.equal((await api.POST(request({answers}))).status,401);assert.equal(calls,0);authenticated=true;
 assert.equal((await api.POST(new Request('http://local.test',{method:'POST',body:'not json'}))).status,400);
 assert.equal((await api.POST(request({answers:[]}))).status,400);assert.equal(calls,0);
 assert.equal((await api.POST(request({answers,padding:'x'.repeat(33000)}))).status,400);assert.equal(calls,0);
 let result=await api.POST(request({answers,email:'attacker@example.test',availableConfiguration:{slack:'available'}}));
 assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'private, no-store');
 let generated=(await result.json()).draft;assert.equal(generated.enabled,true);assert.equal(generated.title,output.title);
 let payload=JSON.parse(captured.body.messages[1].content);
 assert.equal(payload.availableConfiguration.salesforce,'configured_for_user_not_connection_tested');
 assert.equal(payload.availableConfiguration.slack,'not_integrated');assert.equal(payload.availableConfiguration.web,'not_configured');
 assert.equal(captured.body.tools,undefined);assert.equal(captured.options.timeout,45000);assert.equal(captured.options.maxRetries,0);
 assert.ok(captured.body.messages[0].content.includes('cumulative (AND)'),'the generator must preserve all selected requirements');
 assert.ok(captured.options.signal instanceof AbortSignal);assert.equal(captured.body.max_completion_tokens,4000);
 assert.ok(!JSON.stringify(captured.body).includes('secret-do-not-return'));
 result=await api.POST(request({answers,draft:generated,revision:'表形式に変更して'}));assert.equal(result.status,200);
 payload=JSON.parse(captured.body.messages[1].content);assert.equal(payload.revision,'表形式に変更して');assert.equal(payload.existingDraft.content,generated.content);
 finish='length';assert.equal((await api.POST(request({answers}))).status,503);finish='stop';
 output={title:'invalid',content:'あ'.repeat(4001)};assert.equal((await api.POST(request({answers}))).status,503);
 failure=true;result=await api.POST(request({answers}));assert.equal(result.status,503);assert.ok(!(await result.text()).includes('private credential'));failure=false;
 delete process.env.AZURE_OPENAI_API_KEY;const noConfigCalls=calls;assert.equal((await api.POST(request({answers}))).status,503);assert.equal(calls,noConfigCalls);
 console.log('PASS SkillGenerator: authenticated stateless API, bounded input/output, server capabilities, generation/revision, no tools or storage, cancellation signal and safe failure responses');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>envKeys.forEach((key,i)=>{if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];}));
