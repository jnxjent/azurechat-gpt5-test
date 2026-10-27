const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
let received,calls=0;
const moduleRoute={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../app/(authenticated)/api/chat/route.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(id=>{
 if(id.endsWith('/chat-api'))return {ChatAPIEntry:async props=>{received=props;calls++;return new Response('ok');}};
 if(id.endsWith('/image-form-data'))return {readImageFormData:async()=>''};
 throw Error('Unexpected dependency '+id);
},moduleRoute,moduleRoute.exports);
const ownId='skill-'+'a'.repeat(64),publicId='shared-'+'b'.repeat(32);
async function send(id,version){
 const form=new FormData();form.set('content',JSON.stringify({id:'thread',message:'営業進捗をレポートに',skillId:ownId,skillVersion:999}));
 if(id!==undefined)form.set('selectedSkillId',id);
 if(version!==undefined)form.set('selectedSkillVersion',version);
 return moduleRoute.exports.POST(new Request('http://local.test/api/chat',{method:'POST',body:form}));
}
(async()=>{
 assert.equal((await send(publicId,'3')).status,200);assert.equal(received.skillId,publicId);assert.equal(received.skillVersion,3);
 assert.equal((await send(ownId,'2')).status,200);assert.equal(received.skillId,ownId);
 assert.equal((await send()).status,200);assert.equal(received.skillId,undefined);assert.equal(received.skillVersion,undefined,'stale JSON cannot restore a cleared selection');
 for(const [id,version] of [[publicId,undefined],[undefined,'1'],[publicId,'NaN'],[publicId,'0'],[publicId,'9007199254740992'],['shared-other','1']]){
  const before=calls;assert.equal((await send(id,version)).status,400);assert.equal(calls,before);
 }
 console.log('PASS Skill selection multipart transport: exact public/own ID and version, cleared selection and malformed metadata rejection');
})().catch(error=>{console.error(error);process.exitCode=1;});
