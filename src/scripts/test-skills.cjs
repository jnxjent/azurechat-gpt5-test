const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
let owner='user-a', etag=0, failBatch=false, race=false;
const records=new Map(); const messages=[];
const key=(id,user)=>`${user}/${id}`;
const put=body=>records.set(key(body.id,body.userId),structuredClone({...body,_etag:String(++etag)}));
const container={
  item(id,user) {
    assert.equal(user,owner);
    return {
      async read() {const resource=records.get(key(id,user));if(!resource)throw {code:404};return {resource:structuredClone(resource)};},
      async replace(body,options) {
        assert.equal(body.userId,owner);const old=records.get(key(id,user));assert.ok(old);
        assert.equal(options.accessCondition.condition,old._etag);
        if(race){race=false;put(old);throw {code:412};} put(body);
      },
    };
  },
  items:{
    async create(body){assert.equal(body.userId,owner);if(records.has(key(body.id,owner)))throw {code:409};put(body);},
    query(spec,options) {
      assert.equal(options.partitionKey,owner);
      const parameters=Object.fromEntries(spec.parameters.map(p=>[p.name,p.value]));
      assert.equal(parameters['@userId'],owner);
      return {async fetchAll(){return {resources:[...records.values()].filter(item=>item.userId===owner&&item.type===parameters['@type']&&!item.isDeleted).map(item=>structuredClone(item))};}};
    },
    async batch(operations,user) {
      assert.equal(user,owner);
      if(failBatch)return {code:412,result:operations.map(()=>({statusCode:412}))};
      for(const operation of operations) {
        const old=records.get(key(operation.id??operation.resourceBody.id,user));
        if(operation.operationType==='Create'&&old)return {code:409,result:[{statusCode:409}]};
        if(operation.ifMatch&&operation.ifMatch!==old?._etag)return {code:412,result:[{statusCode:412}]};
      }
      operations.forEach(operation=>{assert.equal(operation.resourceBody.userId,owner);put(operation.resourceBody);});
      return {code:200,result:operations.map(()=>({statusCode:200}))};
    },
  },
};
const stubs={
  'server-only':{},
  '@/features/auth-page/helpers':{async userHashedId(){if(!owner)throw Error('User not found');return owner;}},
  '@/features/common/services/cosmos':{HistoryContainer:()=>container},
  '@/features/theme/theme-config':{AI_NAME:'AI'},
  '@/features/chat-page/chat-services/chat-message-service':{
    async CreateChatMessage(message){messages.push(message);return {status:'OK',response:message};},
    async FindTopChatMessagesForCurrentUser(){return {status:'OK',response:[{role:'assistant',content:'直前のプロンプト本文'}]};},
  },
};
const cache=new Map();
function loadFile(filename) {
  filename=path.resolve(filename);if(cache.has(filename))return cache.get(filename).exports;
  const module={exports:{}};cache.set(filename,module);
  const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  new Function('require','module','exports',source)(id=>{
    if(Object.hasOwn(stubs,id))return stubs[id];
    if(id.startsWith('./'))return loadFile(path.resolve(path.dirname(filename),id+'.ts'));
    if(id.startsWith('@/features/skills/'))return loadFile(path.resolve('features/skills',id.split('/').at(-1)+'.ts'));
    return require(id);
  },module,module.exports);return module.exports;
}
const rules=loadFile('features/skills/skill-rules.ts');
const service=loadFile('features/skills/skill-service.ts');
const chat=loadFile('features/skills/skill-chat.ts');
const handler=loadFile('features/skills/skill-chat-handler.ts');
const api=loadFile('app/(authenticated)/api/skills/route.ts');
const input={title:'取引先情報',description:'訪問前に取引先を調べる',content:'# 目的\n指定された取引先の情報を、根拠と未確認事項を分けて整理してください。',enabled:true};
const req=(method,body)=>new Request('http://local.test/api/skills',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

async function main(){
  assert.throws(()=>rules.validateSkill({...input,content:'あ'.repeat(4001)}),/12,000/);
  const portable=rules.exportSkill(input);
  assert.deepEqual(rules.importSkill(portable),{title:input.title,description:input.description,content:input.content});
  assert.equal(rules.importSkill('# 商談分析\n分析する').title,'商談分析');
  assert.equal(rules.importSkill('\uFEFF# 商談分析\r\n本文').content,'# 商談分析\n本文');
  assert.equal(chat.parseSkillCommand('私の名前を覚えておいて'),undefined,'automatic memory must not create a Skill');
  assert.equal(chat.parseSkillCommand('エラーでした'),undefined,'ordinary feedback must not create a visible Skill');
  assert.equal(chat.parseSkillCommand('Skills一覧を見せて').kind,'list');
  assert.equal(chat.parseSkillCommand('Skill「取引先情報」を使って「A社」の名前を含めて調べて'),undefined,'quoted task data must not become a rename');
  assert.equal(chat.parseSkillCommand('Skill「取引先情報」の名前を「取引先調査」に変更して').kind,'rename');
  assert.equal(chat.parseSkillCommand('以下を「取引先情報」のSkillとして保存して\n本文').content,'本文');
  assert.equal(chat.parseSkillCommand('この回答を「取引先情報」のSkillとして保存して','前の回答').content,'前の回答');
  assert.equal(chat.parseSkillCommand('以下を「取引先情報」のSkillとして保存して','前の回答').kind,'needs_content');

  const created=await service.createUserSkill({...input,userId:'attacker',visibility:'public'});
  assert.equal(created.version,1);assert.ok(!('userId' in created));
  const stored=records.get(key(created.id,owner));assert.equal(stored.type,'USER_SKILL');assert.equal(stored.ttl,-1);assert.ok(!('visibility'in stored));
  await assert.rejects(service.createUserSkill(input),/同じ名前/);
  assert.deepEqual(rules.selectSkills([created],'取引先情報について質問です'),[],'mention alone never loads a prompt');
  assert.deepEqual(rules.selectSkills([created],'Skill「取引先情報」を使って調査して'),[created]);
  assert.deepEqual(rules.selectSkills([created],'Skill「取引先情報」で、J&T環境株式会社について調べて。'),[created]);
  assert.deepEqual(rules.selectSkills([created],'スキル『取引先情報』で調べて'),[created]);
  assert.deepEqual(rules.selectSkills([created],'Skill「取引先情報」について質問です'),[]);
  assert.deepEqual(rules.selectSkills([{...created,enabled:false}],'Skill「取引先情報」を使って'),[]);
  assert.deepEqual(rules.selectSkills([created],'違うSkillを使って'),[]);
  const context=rules.formatSkillContext([created]);assert.ok(context.includes(created.content.replace(/\n/g,'\\n')));
  assert.throws(()=>rules.formatSkillContext([created,created,created]),/上限/);
  assert.throws(()=>rules.formatSkillContext([{...created,content:'あ'.repeat(3900)},{...created,content:'い'.repeat(3900)}]),/上限/);

  owner='user-b';assert.deepEqual(await service.listUserSkills(),[]);
  await assert.rejects(service.getUserSkill(created.id),/見つかりません/);
  await assert.rejects(service.updateUserSkill(created.id,input,1),/見つかりません/);
  await assert.rejects(service.deleteUserSkill(created.id,1),/見つかりません/);
  assert.equal((await api.GET(new Request(`http://local.test/api/skills?download=${created.id}`))).status,400);
  owner='user-a';
  put({id:'automatic-memory-v1',userId:owner,type:'USER_AUTOMATIC_MEMORY',records:[{summary:'private'}]});
  assert.equal((await service.listUserSkills()).length,1,'hidden memory never appears in Skills');
  const downloaded=await api.GET(new Request(`http://local.test/api/skills?download=${created.id}`));
  assert.equal(downloaded.status,200);assert.ok(downloaded.headers.get('content-disposition').includes('skill.md'));
  assert.equal(await downloaded.text(),portable);assert.equal(downloaded.headers.get('cache-control'),'private, no-store');
  assert.equal((await api.POST(req('POST',null))).status,400);
  assert.equal((await api.DELETE(req('DELETE',{id:created.id}))).status,400,'delete requires the current version');
  await assert.rejects(service.updateUserSkill(created.id,input,0),/更新されています/);
  race=true;await assert.rejects(service.updateUserSkill(created.id,input,1),/更新されています/);
  failBatch=true;await assert.rejects(service.updateUserSkill(created.id,{...input,title:'取引先調査'},1),/変更できません/);
  assert.equal((await service.getUserSkill(created.id)).title,input.title,'failed rename keeps source intact');failBatch=false;
  const renamed=await service.updateUserSkill(created.id,{...input,title:'取引先調査'},1);
  assert.equal(renamed.version,2);assert.notEqual(renamed.id,created.id);
  await assert.rejects(service.getUserSkill(created.id),/見つかりません/);
  await service.deleteUserSkill(renamed.id,2);assert.deepEqual(await service.listUserSkills(),[]);
  const restored=await service.createUserSkill({...input,title:'取引先調査'});assert.equal(restored.version,4,'delete/recreate cannot reuse stale versions');

  const noReference=await handler.prepareSkillsForChat({message:'普通の質問',threadId:'thread',userName:'User'});assert.deepEqual(noReference,{selected:[]});
  let result=await handler.prepareSkillsForChat({message:'この回答を「営業活動分析」のSkillとして保存して',threadId:'thread',userName:'User'});
  assert.equal(result.response.status,200);assert.ok((await result.response.text()).includes('保存しました'));
  const saved=(await service.listUserSkills()).find(skill=>skill.title==='営業活動分析');assert.equal(saved.content,'直前のプロンプト本文');
  result=await handler.prepareSkillsForChat({message:'Skill「営業活動分析」を使って結果を整理して',threadId:'thread',userName:'User'});
  assert.equal(result.response,undefined);assert.equal(result.selected[0].id,saved.id);
  result=await handler.prepareSkillsForChat({message:'Skill「ない名前」を使って',threadId:'thread',userName:'User'});
  assert.ok((await result.response.text()).includes('見つからない'));
  assert.ok(messages.every(message=>message.chatThreadId==='thread'));
  owner='';assert.equal((await api.GET(new Request('http://local.test/api/skills'))).status,401);
  assert.equal((await api.POST(req('POST',input))).status,401);
  console.log('PASS Skills: private CRUD/API/download, normalized names, versions, atomic rename, disabled/deleted isolation, Markdown roundtrip, explicit chat save/reference and token budgets');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
