const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),crypto=require('node:crypto');
const tenant='11111111-1111-1111-1111-111111111111';
const users=['owner','reader','outsider'].map((name,i)=>({name,email:`${name}@example.com`,salesforcePrincipal:`${tenant}:${String(i+2).repeat(8)}-${String(i+2).repeat(4)}-${String(i+2).repeat(4)}-${String(i+2).repeat(4)}-${String(i+2).repeat(12)}`}));
const records=new Map(),root=path.resolve(__dirname,'..'),cache=new Map();let etag=0,allowed=true,sfCalls=0;
const container={items:{async create(item){records.set(item.id,{...structuredClone(item),_etag:String(++etag)});}},item(id,partition){assert.equal(partition,'CANVAS_SHARE');return {async read(){if(!records.has(id))throw {code:404};return {resource:structuredClone(records.get(id))};},async replace(item,options){if(records.get(id)?._etag!==options.accessCondition.condition)throw {code:412};records.set(id,{...structuredClone(item),_etag:String(++etag)});}};}};
const stubs={'server-only':{},'@/features/auth-page/helpers':{getCurrentUser:async()=>{throw Error('User not found');}},'@/features/common/services/cosmos':{HistoryContainer:()=>container},'@/features/common/services/salesforce-access':{isSalesforceAllowedEmail:email=>users.some(u=>u.email===email)}};
function load(relative){const file=path.resolve(root,relative);if(cache.has(file))return cache.get(file);const mod={exports:{}};cache.set(file,mod.exports);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;new Function('require','module','exports',code)(id=>stubs[id]??(id.startsWith('@/')?load(id.slice(2)+'.ts'):id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id)),mod,mod.exports);return mod.exports;}
const actors=load('features/canvas/canvas-actor.ts'),share=load('features/canvas/shared-canvas-service.ts'),teams=load('features/teams/teams-canvas-service.ts');
global.fetch=async(url,options)=>{
 sfCalls++;const current=await actors.getCanvasActor(),claim=JSON.parse(Buffer.from(options.headers['X-AC-Identity'],'base64url'));assert.equal(claim.principal,current.salesforcePrincipal);assert.equal(claim.email,current.email);assert.equal(url.origin,'https://personal.example.com');
 const data=url.pathname==='/api/sf/query_nl'?{ok:true,snapshot_proof:'proof',items:[{Name:'PRIVATE FINANCIAL DATA'}]}:{ok:true,allowed};
 await new Promise(resolve=>setImmediate(resolve));
 return Response.json(data,{headers:{'X-SF-Connection-Mode':'personal-oauth','X-AC-Principal':current.salesforcePrincipal,'X-SF-User-Id':'005000000000001AAA','X-SF-Org-Id':'00D000000000001AAA'}});
};
let rosterOverride=null;
const api={conversations:{members:conversation=>({getById:async id=>{const user=users.find(u=>'teams-'+u.name===id);if(!user)throw Error('member not found');return rosterOverride??{id,tenantId:tenant,aadObjectId:user.salesforcePrincipal.split(':')[1],email:user.email};}})}};
const activity=(user,extra={})=>({channelId:'msteams',conversation:{id:'personal-'+user.name,conversationType:'personal',tenantId:tenant},from:{id:'teams-'+user.name,aadObjectId:user.salesforcePrincipal.split(':')[1]},...extra});
const actor=user=>({salesforcePrincipal:user.salesforcePrincipal,email:user.email});
const under=(user,fn)=>actors.withCanvasActor(actor(user),fn);
const action=(card,operation)=>card.actions.find(a=>a.data?.operation===operation).data;
const handle=(user,extra)=>teams.handleTeamsCanvas(activity(user,extra),api);
async function main(){
 Object.assign(process.env,{NEXTAUTH_URL:'https://test.example.com',TEAMS_TENANT_ID:tenant,TEAMS_SKIP_AUTH:'false',SF_PERSONAL_MODE:'true',SF_PERSONAL_AUTH_METHOD:'oauth',SF_PERSONAL_SNAPSHOT_POLICY:'strict',SF_PERSONAL_SIGNING_KEY:'x'.repeat(40),SF_GATEWAY_BASE_URL:'https://shared.example.com',SF_PERSONAL_GATEWAY_BASE_URL:'https://personal.example.com',SF_PERSONAL_USERS_JSON:JSON.stringify(users.map(u=>({principal:u.salesforcePrincipal,email:u.email}))),CANVAS_SHARE_USERS_JSON:JSON.stringify(users.map(u=>({principal:u.salesforcePrincipal,email:u.email,name:u.name,department:'営業部'})))});delete process.env.CANVAS_SHARE_DIRECTORY_PROVIDER;
 await assert.rejects(()=>actors.getCanvasActor(),/User not found/);
 const created=await under(users[0],()=>share.createSharedCanvas('report'));
 await under(users[0],()=>share.changeSharedCanvas(created.id,{action:'access',revision:1,readers:[users[1].email],permissions:{[users[1].email]:'comment'},enabled:true}));
 const url=`https://test.example.com/canvas/shared/${created.id}`;
 assert.equal(teams.teamsCanvasLink('共有レポート '+url),created.id);
 for(const bad of [url.replace('test.example.com','evil.example.com'),url+'?x=1',url+'#x',url.replace('https:','http:'),url.replace('test.example.com','user@test.example.com')])assert.equal(teams.teamsCanvasLink(bad),null);
 let result=await handle(users[1],{text:url});assert.ok(result.card);assert.ok(!JSON.stringify(result).includes('PRIVATE FINANCIAL DATA'));
 let post=action(result.card,'post');assert.equal(result.card.actions.find(a=>a.data?.operation==='post').type,'Action.Submit');
 result=await handle(users[1],{value:{...post,commentBody:'PRIVATE DISCUSSION',replyTo:'new',email:users[0].email,principal:users[0].salesforcePrincipal}});assert.ok(result.card);assert.ok(!JSON.stringify(result).includes('PRIVATE DISCUSSION'));
 let report=await under(users[0],()=>share.getSharedCanvas(created.id));assert.equal(report.comments.length,1);assert.equal(report.comments[0].authorName,'reader');const comment=report.comments[0];
 const duplicate=await handle(users[1],{value:{...post,commentBody:'PRIVATE DISCUSSION',replyTo:'new'}});assert.ok(duplicate.text.includes('更新'));assert.equal((await under(users[0],()=>share.getSharedCanvas(created.id))).comments.length,1);
 const readerCard=result.card;
 result=await handle(users[0],{text:url});const ownerPost=action(result.card,'post');
 result=await handle(users[0],{value:{...ownerPost,replyTo:comment.id,commentBody:'owner reply'}});assert.ok(result.card);
 report=await under(users[0],()=>share.getSharedCanvas(created.id));assert.equal(report.comments[1].parentId,comment.id);assert.equal(report.comments[1].authorName,'owner');
 const before=sfCalls;
 result=await handle(users[0],{value:{...action(readerCard,'post'),commentBody:'forwarded'}});assert.ok(result.text.includes('別の利用者'));assert.equal(sfCalls,before);
 result=await handle(users[1],{value:{...post,shareId:crypto.randomUUID(),commentBody:'wrong report'}});assert.ok(result.text.includes('別の利用者'));assert.equal(sfCalls,before);
 result=await handle(users[1],{value:{...post,token:post.token+'x',commentBody:'forged'}});assert.ok(result.text.includes('期限切れ'));assert.equal(sfCalls,before);
 result=await handle(users[1],{text:url,conversation:{id:'group',conversationType:'groupChat',tenantId:tenant}});assert.ok(result.text.includes('個人チャット'));assert.equal(sfCalls,before);
 result=await handle(users[1],{text:url,conversation:{id:'other',conversationType:'personal',tenantId:'99999999-9999-9999-9999-999999999999'}});assert.ok(result.text.includes('所属組織'));assert.equal(sfCalls,before);
 rosterOverride={email:users[1].email,aadObjectId:users[0].salesforcePrincipal.split(':')[1],tenantId:tenant};result=await handle(users[1],{text:url});assert.ok(result.text.includes('本人対応'));rosterOverride=null;
 result=await handle(users[2],{text:url});assert.ok(!result.card);
 process.env.TEAMS_SKIP_AUTH='true';result=await handle(users[1],{text:url});assert.ok(result.text.includes('認証を省略'));process.env.TEAMS_SKIP_AUTH='false';
 // Simultaneous activity processing must not share cookie or roster identities.
 const pair=await Promise.all([handle(users[0],{text:url}),handle(users[1],{text:url})]);assert.ok(pair.every(r=>r.card));await assert.rejects(()=>actors.getCanvasActor(),/User not found/);
 report=await under(users[0],()=>share.getSharedCanvas(created.id));await under(users[0],()=>share.changeSharedCanvas(created.id,{action:'access',revision:report.revision,readers:[users[1].email],permissions:{[users[1].email]:'view'},enabled:true}));
 result=await handle(users[1],{text:url});assert.ok(!result.card.actions.some(a=>a.data?.operation==='post'));
 const refresh=action(result.card,'refresh');result=await handle(users[1],{value:{...refresh,operation:'post',commentBody:'bypass readonly'}});assert.ok(result.text.includes('権限'));
 report=await under(users[0],()=>share.getSharedCanvas(created.id));await under(users[0],()=>share.changeSharedCanvas(created.id,{action:'access',revision:report.revision,readers:[users[1].email],permissions:{[users[1].email]:'comment'},enabled:true}));
 result=await handle(users[1],{text:url});post=action(result.card,'post');allowed=false;
 result=await handle(users[1],{value:{...post,commentBody:'lost SF permission'}});assert.ok(!result.card);assert.ok(result.text.includes('Salesforce'));allowed=true;
 const realNow=Date.now;Date.now=()=>realNow()-1900000;
 let expired;try{expired=await handle(users[1],{text:url});}finally{Date.now=realNow;}
 result=await handle(users[1],{value:{...action(expired.card,'post'),commentBody:'expired'}});assert.ok(result.text.includes('期限切れ'));
 report=await under(users[0],()=>share.getSharedCanvas(created.id));await under(users[0],()=>share.changeSharedCanvas(created.id,{action:'access',revision:report.revision,readers:[],enabled:false}));
 result=await handle(users[1],{value:{...post,operation:'refresh'}});assert.ok(!result.card);assert.equal(records.get('shared-canvas-'+created.id).comments.length,2);
 // Exercise both SDK entry routes with the real Canvas handler. Other bot services are not called.
 report=await under(users[0],()=>share.getSharedCanvas(created.id));await under(users[0],()=>share.changeSharedCanvas(created.id,{action:'access',revision:report.revision,readers:[users[1].email],permissions:{[users[1].email]:'comment'},enabled:true}));
 Object.assign(process.env,{TEAMS_ENABLED:'true',TEAMS_BOT_ID:'test-bot',TEAMS_BOT_SECRET:'test-only'});
 const routes=new Map(),appModule={exports:{}};
 class App{on(event,handler){routes.set(event,handler);}async initialize(){}}
 const appCode=ts.transpileModule(fs.readFileSync(path.join(root,'features/teams/teams-app.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 const appMocks={'@microsoft/teams.apps':{App},'./next-http-adapter':{NextHttpAdapter:class{}},'./teams-canvas-service':teams,'./teams-file-policy':{stripTeamsAttachmentMarkup:text=>text},'./teams-usage-service':{recordTeamsChatTurn:async()=>{},recordTeamsThreadUsage:async()=>{}}};
 new Function('require','module','exports',appCode)(id=>appMocks[id]??{},appModule,appModule.exports);
 await appModule.exports.getTeamsRuntime();let sent=[];
 await routes.get('message')({activity:{...activity(users[1],{text:url}),id:'open-card'},api,send:async value=>sent.push(value)});
 const sdkCard=sent.find(v=>v.attachments)?.attachments[0].content;assert.ok(sdkCard);
 const invoked=await routes.get('card.action')({activity:activity(users[1],{value:{action:{data:{...action(sdkCard,'post'),commentBody:'SDK invoke',replyTo:'new'}}}}),api});
 assert.equal(invoked.type,'application/vnd.microsoft.card.adaptive');
 sent=[];await routes.get('message')({activity:{...activity(users[1],{value:{...action(invoked.value,'post'),commentBody:'SDK submit',replyTo:'new'}}),id:'submit-card'},api,send:async value=>sent.push(value)});
 assert.ok(sent.some(v=>v.attachments));assert.equal(records.get('shared-canvas-'+created.id).comments.length,4);
 console.log('PASS Teams Canvas: SDK message/card.action routes, verified roster identity, actor isolation, personal chat/tenant guards, links/cards, native comments/replies, no private content in cards, forged/expired/forwarded cards, duplicate writes, viewer downgrade, SF denial and revocation');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
