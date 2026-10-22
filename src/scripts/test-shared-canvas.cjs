const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const tenant = '11111111-1111-1111-1111-111111111111';
const users = ['a','b','c'].map((x,i) => ({ email: `${x}@example.com`, salesforcePrincipal: `${tenant}:${String(i+2).repeat(8)}-${String(i+2).repeat(4)}-${String(i+2).repeat(4)}-${String(i+2).repeat(4)}-${String(i+2).repeat(12)}` }));
let user = users[0], allowed = true, sfVersion = 1, calls = 0, etag = 0, checkHook;
const records = new Map();
const container = { items: { async create(item) { assert.equal(item.userId,'CANVAS_SHARE'); records.set(item.id,{...structuredClone(item),_etag:String(++etag)}); } }, item(id,partition) {
 assert.equal(partition,'CANVAS_SHARE'); return {
 async read(){ if(!records.has(id))throw {code:404}; return {resource:structuredClone(records.get(id))}; },
 async replace(item,options){assert.equal(options.accessCondition.type,'IfMatch');if(records.get(id)?._etag!==options.accessCondition.condition)throw {code:412};records.set(id,{...structuredClone(item),_etag:String(++etag)});}
 }; } };
const cache = new Map(), root=path.resolve(__dirname,'..');
const stubs = { 'server-only': {}, '@/features/auth-page/helpers': {getCurrentUser:async()=>{if(!user)throw Error('User not found');return user;}}, '@/features/common/services/cosmos': {HistoryContainer:()=>container}, '@/features/common/services/salesforce-access': {isSalesforceAllowedEmail:()=>true} };
function load(relative){const file=path.resolve(root,relative);if(cache.has(file))return cache.get(file);const mod={exports:{}};cache.set(file,mod.exports);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;new Function('require','module','exports',code)(id=>stubs[id]??(id.startsWith('@/')?load(id.slice(2)+'.ts'):id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id)),mod,mod.exports);return mod.exports;}
global.fetch=async(url,options)=>{
 calls++; const claim=JSON.parse(Buffer.from(options.headers['X-AC-Identity'],'base64url'));assert.equal(claim.principal,user.salesforcePrincipal);assert.equal(claim.email,user.email);assert.equal(url.origin,'https://gateway.example.com');
 const principal=claim.principal;let data;
 if(url.pathname==='/api/sf/query_nl') data={ok:true,snapshot_proof:'signed-source-proof',items:[{Name:'record-'+sfVersion,_instruction:'private-internal',attributes:{},nested:{secret:'private-internal'}}]};
 else {assert.equal(url.pathname,'/api/sf/revalidate_shared');assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).proof,'signed-source-proof');if(checkHook){const hook=checkHook;checkHook=null;await hook();}data={ok:true,allowed};}
 return Response.json(data,{headers:{'X-SF-Connection-Mode':'personal-oauth','X-AC-Principal':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
};
async function main(){
 Object.assign(process.env,{NEXTAUTH_URL:'https://ac.example.com',SF_PERSONAL_MODE:'false',SF_PERSONAL_AUTH_METHOD:'oauth',SF_PERSONAL_SNAPSHOT_POLICY:'strict',SF_PERSONAL_SIGNING_KEY:'x'.repeat(40),SF_GATEWAY_BASE_URL:'https://shared.example.com',SF_PERSONAL_GATEWAY_BASE_URL:'https://gateway.example.com',CANVAS_SHARE_USERS_JSON:JSON.stringify(users.map(u=>({email:u.email,principal:u.salesforcePrincipal})))});
 const api=load('features/canvas/shared-canvas-service.ts');
 const created=await api.createSharedCanvas('私の取引先');const id=created.id;
 let result=await api.getSharedCanvas(id);assert.equal(result.owner,true);assert.ok(result.document.content.includes('record-1'));assert.ok(!JSON.stringify(result).includes('signed-source-proof'));assert.ok(!JSON.stringify(result).includes('private-internal'));
 user=users[1];let before=calls;await assert.rejects(()=>api.getSharedCanvas(id),e=>e.status===404);assert.equal(calls,before,'unauthorized requests must not reach Salesforce');
 user=users[0];await api.changeSharedCanvas(id,{revision:1,action:'access',readers:[users[1].email],enabled:true});
 user=users[1];result=await api.getSharedCanvas(id);assert.equal(result.owner,false);assert.equal(result.query,undefined);assert.ok(result.document.content.includes('record-1'));
 await assert.rejects(()=>api.changeSharedCanvas(id,{revision:2,action:'refresh'}),e=>e.status===404);
 allowed=false;await assert.rejects(()=>api.getSharedCanvas(id),e=>e.status===403);allowed=true;
 user=users[2];before=calls;await assert.rejects(()=>api.getSharedCanvas(id),e=>e.status===404);assert.equal(calls,before);
 user=users[0];sfVersion=2;await api.changeSharedCanvas(id,{revision:2,action:'refresh'});
 user=users[1];result=await api.getSharedCanvas(id);assert.ok(result.document.content.includes('record-2'));assert.equal(result.revision,3);
 checkHook=async()=>{user=users[0];await api.changeSharedCanvas(id,{revision:3,action:'access',readers:[],enabled:false});user=users[1];};
 await assert.rejects(()=>api.getSharedCanvas(id),e=>e.status===404);
 user=users[0];await assert.rejects(()=>api.changeSharedCanvas(id,{revision:3,action:'access',readers:[],enabled:false}),e=>e.status===409);
 allowed=false;result=await api.getSharedCanvas(id);assert.equal(result.restricted,true);assert.equal(result.document,undefined);await api.changeSharedCanvas(id,{revision:4,action:'access',readers:[],enabled:false});allowed=true;
 records.get('shared-canvas-'+id).document.content='tampered';await assert.rejects(()=>api.getSharedCanvas(id),e=>e.status===404);
 const http=load('features/canvas/shared-canvas-http.ts');
 assert.throws(()=>http.requireCanvasOrigin(new Request('http://localhost/api/canvas/shared',{headers:{origin:'https://evil.example.com'}})),e=>e.status===403);
 http.requireCanvasOrigin(new Request('http://localhost/api/canvas/shared',{headers:{origin:'https://ac.example.com'}}));
 const route=load('app/(authenticated)/api/canvas/shared/[id]/route.ts');
 user=null;await assert.rejects(()=>api.getSharedCanvas(id),/User not found/);
 const response=await route.GET(new Request('https://ac.example.com/api/canvas/shared/'+id),{params:{id}});
 assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.ok(!JSON.stringify(await response.json()).includes('record-'));
 console.log('PASS shared Canvas: named ACL, viewer-specific SF checks, stable URL/latest data, revoke during access, no cached authorization, lost owner permissions, stale versions and tampering');
}
main().catch(e=>{console.error(e);process.exitCode=1});
