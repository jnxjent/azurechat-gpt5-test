const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const tenant = '11111111-1111-1111-1111-111111111111';
const users = ['a','b','c'].map((x,i) => ({ email: `${x}@example.com`, salesforcePrincipal: `${tenant}:${String(i+2).repeat(8)}-${String(i+2).repeat(4)}-${String(i+2).repeat(4)}-${String(i+2).repeat(4)}-${String(i+2).repeat(12)}` }));
let user = users[0], allowed = true, sfVersion = 1, calls = 0, etag = 0, checkHook, expectedProof, expectedThread;
const records = new Map();
const container = { items: { async create(item) { assert.equal(item.userId,'CANVAS_SHARE'); records.set(item.id,{...structuredClone(item),_etag:String(++etag)}); } }, item(id,partition) {
 assert.equal(partition,'CANVAS_SHARE'); return {
 async read(){ if(!records.has(id))throw {code:404}; return {resource:structuredClone(records.get(id))}; },
 async replace(item,options){assert.equal(options.accessCondition.type,'IfMatch');if(records.get(id)?._etag!==options.accessCondition.condition)throw {code:412};records.set(id,{...structuredClone(item),_etag:String(++etag)});}
 }; } };
const cache = new Map(), root=path.resolve(__dirname,'..');
const stubs = { 'server-only': {}, './share-directory':{salesforceShareDirectory:async()=>{throw Error('directory unavailable');}}, '@/features/auth-page/helpers': {getCurrentUser:async()=>{if(!user)throw Error('User not found');return user;}}, '@/features/common/services/cosmos': {HistoryContainer:()=>container}, '@/features/common/services/salesforce-access': {isSalesforceAllowedEmail:()=>true} };
function load(relative){const file=path.resolve(root,relative);if(cache.has(file))return cache.get(file);const mod={exports:{}};cache.set(file,mod.exports);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;new Function('require','module','exports',code)(id=>stubs[id]??(id.startsWith('@/')?load(id.slice(2)+'.ts'):id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id)),mod,mod.exports);return mod.exports;}
global.fetch=async(url,options)=>{
 calls++; const claim=JSON.parse(Buffer.from(options.headers['X-AC-Identity'],'base64url'));assert.equal(claim.principal,user.salesforcePrincipal);assert.equal(claim.email,user.email);assert.equal(url.origin,'https://gateway.example.com');
 const principal=claim.principal;let data;
 if(url.pathname==='/api/sf/query_nl') data={ok:true,snapshot_proof:'signed-source-proof',items:[{Name:'record-'+sfVersion,_instruction:'private-internal',attributes:{},nested:{secret:'private-internal'}}]};
 else {assert.equal(url.pathname,'/api/sf/revalidate_shared');assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).proof,expectedProof||'signed-source-proof');if(expectedThread){assert.equal(claim.thread,expectedThread);assert.equal(options.headers['X-Chat-Thread-Id'],expectedThread);}if(checkHook){const hook=checkHook;checkHook=null;await hook();}data={ok:true,allowed};}
 return Response.json(data,{headers:{'X-SF-Connection-Mode':'personal-oauth','X-AC-Principal':principal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
};
async function main(){
 Object.assign(process.env,{NEXTAUTH_URL:'https://ac.example.com',SF_PERSONAL_MODE:'false',SF_PERSONAL_AUTH_METHOD:'oauth',SF_PERSONAL_SNAPSHOT_POLICY:'strict',SF_PERSONAL_SIGNING_KEY:'x'.repeat(40),SF_GATEWAY_BASE_URL:'https://shared.example.com',SF_PERSONAL_GATEWAY_BASE_URL:'https://gateway.example.com',CANVAS_SHARE_USERS_JSON:JSON.stringify(users.map(u=>({email:u.email,principal:u.salesforcePrincipal})))});
 const {skillGatewayThread}=load('features/common/services/salesforce-proof-thread.ts');
 const {revalidateCanvasSource}=load('features/canvas/canvas-source.ts');
 expectedThread=skillGatewayThread('source-chat');expectedProof=Buffer.from(JSON.stringify({thread:expectedThread})).toString('base64url')+'.gateway-signature';
 const scopedSource={provider:'salesforce',query:'read-only',thread:'source-chat',proof:expectedProof};
 const viewer={principal:user.salesforcePrincipal,email:user.email};
 assert.equal(await revalidateCanvasSource(scopedSource,viewer),true,'Shared sources retain isolated Skill proof contexts');
 allowed=false;assert.equal(await revalidateCanvasSource(scopedSource,viewer),false,'Current viewer revocation still denies isolated proofs');allowed=true;
 const beforeForeign=calls;assert.equal(await revalidateCanvasSource({...scopedSource,thread:'foreign-chat'},viewer),false);assert.equal(calls,beforeForeign,'Do not sign a context belonging to a different source chat');
 expectedThread=undefined;expectedProof=undefined;
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
 // New comments use the same ACL, SF checks, signed record, revision and ETag.
 user=users[0];const second=await api.createSharedCanvas('comments');const cid=second.id;
 await api.changeSharedCanvas(cid,{revision:1,action:'access',readers:[users[1].email,users[2].email],permissions:{[users[1].email]:'comment',[users[2].email]:'view'},enabled:true});
 user=users[2];result=await api.getSharedCanvas(cid);assert.equal(result.canComment,false);
 await assert.rejects(()=>api.changeCanvasComment(cid,{revision:2,action:'create',body:'forbidden'}),e=>e.status===403);
 user=users[1];await api.changeCanvasComment(cid,{revision:2,action:'create',body:'<script>alert(1)</script>'});
 result=await api.getSharedCanvas(cid);assert.equal(result.canComment,true);assert.equal(result.comments.length,1);const comment=result.comments[0];assert.equal(comment.reportVersion,1);assert.equal(comment.mine,true);assert.ok(!JSON.stringify(result.comments).includes('principal'));
 user=users[0];await api.changeCanvasComment(cid,{revision:3,action:'create',parentId:comment.id,body:'owner reply'});
 user=users[1];result=await api.getSharedCanvas(cid);const reply=result.comments[1];assert.equal(reply.parentId,comment.id);
 await assert.rejects(()=>api.changeCanvasComment(cid,{revision:4,action:'edit',id:reply.id,body:'not mine'}),e=>e.status===403);
 await assert.rejects(()=>api.changeCanvasComment(cid,{revision:4,action:'create',body:'あ'.repeat(1400)}),e=>e.status===400);
 await assert.rejects(()=>api.changeCanvasComment(cid,{revision:4,action:'create',body:' '}),e=>e.status===400);
 await assert.rejects(()=>api.changeCanvasComment(cid,{revision:4,action:'create',parentId:'missing',body:'bad reply'}),e=>e.status===400);
 await api.changeCanvasComment(cid,{revision:4,action:'edit',id:comment.id,body:'edited'});
 await assert.rejects(()=>api.changeCanvasComment(cid,{revision:4,action:'delete',id:comment.id}),e=>e.status===409);
 await api.changeCanvasComment(cid,{revision:5,action:'delete',id:comment.id});
 result=await api.getSharedCanvas(cid);assert.equal(result.comments[0].deleted,true);assert.equal(result.comments[0].body,'');assert.equal(result.comments[1].body,'owner reply');
 user=users[0];sfVersion++;await api.changeSharedCanvas(cid,{revision:6,action:'refresh'});
 result=await api.getSharedCanvas(cid);assert.equal(result.comments.length,2);assert.equal(result.comments[1].reportVersion,1);assert.equal(result.document.version,2);
 allowed=false;result=await api.getSharedCanvas(cid);assert.equal(result.comments,undefined);await assert.rejects(()=>api.changeCanvasComment(cid,{revision:7,action:'create',body:'no SF access'}),e=>e.status===403);allowed=true;
 user=users[1];checkHook=async()=>{user=users[0];await api.changeSharedCanvas(cid,{revision:7,action:'access',readers:[],enabled:false});user=users[1];};
 await assert.rejects(()=>api.changeCanvasComment(cid,{revision:7,action:'create',body:'revoked during check'}),e=>e.status===404);
 assert.equal(records.get('shared-canvas-'+cid).comments.length,2);
 user=users[0];await api.changeSharedCanvas(cid,{revision:8,action:'access',readers:[users[1].email],permissions:{[users[1].email]:'view'},enabled:true});
 user=users[1];await assert.rejects(()=>api.changeCanvasComment(cid,{revision:9,action:'create',body:'downgraded'}),e=>e.status===403);
 // A lost response can be retried using the same request ID, but cannot bypass
 // revocation, a role downgrade, SF checks, or another author's identity.
 user=users[0];const retryReport=await api.createSharedCanvas('retry');
 await api.changeSharedCanvas(retryReport.id,{revision:1,action:'access',readers:[users[1].email],permissions:{[users[1].email]:'comment'},enabled:true});
 const requestId=require('node:crypto').randomUUID();
 user=users[1];const posted=await api.changeCanvasComment(retryReport.id,{revision:2,action:'create',body:'once',requestId});
 assert.equal(posted.comment.id,requestId);assert.equal(posted.comment.body,'once');assert.equal(posted.duplicate,false);
 const retried=await api.changeCanvasComment(retryReport.id,{revision:2,action:'create',body:'once',requestId});assert.equal(retried.duplicate,true);assert.equal(retried.revision,3);
 assert.equal(records.get('shared-canvas-'+retryReport.id).comments.length,1);
 await assert.rejects(()=>api.changeCanvasComment(retryReport.id,{revision:2,action:'create',body:'changed',requestId}),e=>e.status===409);
 allowed=false;await assert.rejects(()=>api.changeCanvasComment(retryReport.id,{revision:2,action:'create',body:'once',requestId}),e=>e.status===403);allowed=true;
 user=users[0];await assert.rejects(()=>api.changeCanvasComment(retryReport.id,{revision:3,action:'create',body:'once',requestId}),e=>e.status===409);
 await api.changeSharedCanvas(retryReport.id,{revision:3,action:'access',readers:[users[1].email],permissions:{[users[1].email]:'view'},enabled:true});
 user=users[1];await assert.rejects(()=>api.changeCanvasComment(retryReport.id,{revision:2,action:'create',body:'once',requestId}),e=>e.status===403);
 const commentsRoute=load('app/(authenticated)/api/canvas/shared/[id]/comments/route.ts');
 // Editor rights never imply ownership or permission to replace source proofs.
 user=users[0];result=await api.getSharedCanvas(retryReport.id);
 const access=await api.changeSharedCanvas(retryReport.id,{revision:result.revision,action:'access',enabled:true,readers:[users[1].email],permissions:{[users[1].email]:'edit'},message:'Initial sharing message'});
 user=users[1];result=await api.getSharedCanvas(retryReport.id);assert.equal(result.canEdit,true);assert.equal(result.canComment,true);assert.ok(!result.comments.some(c=>c.body==='Initial sharing message'));
 await assert.rejects(()=>api.changeSharedCanvas(retryReport.id,{revision:access.revision,action:'access',enabled:true,readers:[users[2].email]}),e=>e.status===404);
 await assert.rejects(()=>api.changeSharedCanvas(retryReport.id,{revision:access.revision,action:'edit',document:{threadId:'other'}}),e=>e.status===400);
 allowed=false;await assert.rejects(()=>api.changeSharedCanvas(retryReport.id,{revision:access.revision,action:'edit',document:{content:'not allowed'}}),e=>e.status===403);allowed=true;
 await api.changeSharedCanvas(retryReport.id,{revision:access.revision,action:'edit',document:{title:'Edited',content:'Edited body',unit:'円'}});
 result=await api.getSharedCanvas(retryReport.id);assert.equal(result.document.title,'Edited');assert.equal(result.document.version,2);assert.equal(result.owner,false);
 user=users[0];const beforeMessage=records.get('shared-canvas-'+retryReport.id)._etag;
 await assert.rejects(()=>api.changeSharedCanvas(retryReport.id,{revision:result.revision,action:'access',enabled:true,readers:[users[1].email],message:'あ'.repeat(1400)}),e=>e.status===400);
 assert.equal(records.get('shared-canvas-'+retryReport.id)._etag,beforeMessage,'invalid invitation message must not partially save the ACL');
 const editRoute=load('app/(authenticated)/api/canvas/shared/[id]/route.ts'),longBody='訪問メモ'.repeat(2500);
 const editResponse=await editRoute.PUT(new Request('https://ac.example.com/api/canvas/shared/'+retryReport.id,{method:'PUT',headers:{origin:'https://ac.example.com'},body:JSON.stringify({action:'edit',revision:result.revision,document:{content:longBody}})}),{params:{id:retryReport.id}});
 assert.equal(editResponse.status,200,'editable reports support more than the old 8 KB sharing payload');assert.equal((await api.getSharedCanvas(retryReport.id)).document.content,longBody);
 assert.equal((await commentsRoute.POST(new Request('https://ac.example.com/api/canvas/shared/'+cid+'/comments',{method:'POST',headers:{origin:'https://evil.example.com'},body:'{}'}),{params:{id:cid}})).status,403);
 user=null;assert.equal((await commentsRoute.POST(new Request('https://ac.example.com/api/canvas/shared/'+cid+'/comments',{method:'POST',headers:{origin:'https://ac.example.com'},body:'{}'}),{params:{id:cid}})).status,401);
 process.env.CANVAS_SHARE_DIRECTORY_PROVIDER='salesforce';user=users[0];result=await api.getSharedCanvas(cid);assert.equal(result.restricted,true);assert.equal(result.comments,undefined);assert.equal(result.document,undefined);
 user=users[1];await assert.rejects(()=>api.getSharedCanvas(cid),/directory unavailable/);
 user=users[0];await api.changeSharedCanvas(cid,{revision:9,action:'access',readers:[],enabled:false});assert.equal(records.get('shared-canvas-'+cid).enabled,false,'owner can revoke without SF directory');delete process.env.CANVAS_SHARE_DIRECTORY_PROVIDER;
 records.get('shared-canvas-'+cid).comments[1].body='tampered comment';await assert.rejects(()=>api.getSharedCanvas(cid),e=>e.status===404);
 const http=load('features/canvas/shared-canvas-http.ts');
 assert.throws(()=>http.requireCanvasOrigin(new Request('http://localhost/api/canvas/shared',{headers:{origin:'https://evil.example.com'}})),e=>e.status===403);
 http.requireCanvasOrigin(new Request('http://localhost/api/canvas/shared',{headers:{origin:'https://ac.example.com'}}));
 const route=load('app/(authenticated)/api/canvas/shared/[id]/route.ts');
 user=null;await assert.rejects(()=>api.getSharedCanvas(id),/User not found/);
 const response=await route.GET(new Request('https://ac.example.com/api/canvas/shared/'+id),{params:{id}});
 assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.ok(!JSON.stringify(await response.json()).includes('record-'));
 console.log('PASS shared Canvas: ACL, SF checks, comment roles/replies/own edits/deletion, preserved report versions, revoke during writes, downgrade, limits, CSRF, authentication, stale revisions and signed comment tampering');
}
main().catch(e=>{console.error(e);process.exitCode=1});
