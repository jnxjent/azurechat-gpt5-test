const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const tenant='11111111-1111-1111-1111-111111111111',ownerId='22222222-2222-2222-2222-222222222222',readerId='33333333-3333-3333-3333-333333333333';
const owner={principal:`${tenant}:${ownerId}`,email:'owner@example.com',name:'Owner'};
const reader={principal:`${tenant}:${readerId}`,email:'reader@example.com',name:'Reader'};
let authToken,targets,calls,handler,lookups,failLookup;
function load(file,stubs){const mod={exports:{}};const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;new Function('require','module','exports',code)(name=>Object.hasOwn(stubs,name)?stubs[name]:require(name),mod,mod.exports);return mod.exports;}
const {notifyPersonalCanvasShare:notifyRequest}=load('features/canvas/canvas-personal-notifications.ts',{
 'server-only':{},
 './shared-canvas-service':{canvasNotificationTargets:async()=>{lookups++;if(lookups===failLookup)throw Error('Access revoked');return targets;}}
});
async function notify(shareId,message){
 const {encode}=require('next-auth/jwt');
 const cookie=authToken?await encode({token:authToken,secret:process.env.NEXTAUTH_SECRET}):'';
 const chunks=cookie.match(/.{1,3800}/g)||[];
 const cookieName=process.env.NEXTAUTH_URL.startsWith('https:')?'__Secure-next-auth.session-token':'next-auth.session-token';
 const header=chunks.length>1?chunks.map((chunk,i)=>`${cookieName}.${i}=${chunk}`).join('; '):`${cookieName}=${cookie}`;
 const request=new Request('https://test.example.com/api/canvas/shared/share-id',{method:'PUT',headers:{Cookie:header},body:'{}'});
 await request.text(); // Production routes pass an already-consumed body.
 return notifyRequest(request,shareId,message);
}
function reset(){
 Object.assign(process.env,{AZURE_AD_TENANT_ID:tenant,NEXTAUTH_URL:'https://test.example.com',CANVAS_TEAMS_PERSONAL_NOTIFICATIONS_ENABLED:'true',NEXTAUTH_SECRET:'test-only-nextauth-encryption-secret'});
 authToken={email:owner.email,salesforcePrincipal:owner.principal,accessToken:'delegated-test-token',accessTokenExpiresAt:Date.now()/1000+3600,graphProvider:'azure-ad',graphScopes:'User.Read Chat.Create ChatMessage.Send'};
 targets={owner,revision:4,readers:[reader],unavailable:0,unavailableReaders:[]};calls=[];lookups=0;failLookup=0;
 handler=async(url,options)=>url.includes('/me?')?Response.json({id:ownerId}):url.endsWith('/chats')?Response.json({id:'19:existing-chat@thread.v2'}):Response.json({id:'message'});
 global.fetch=async(url,options)=>{calls.push({url,options,body:options.body?JSON.parse(options.body):undefined});assert.equal(options.headers.Authorization,'Bearer delegated-test-token');assert.equal(options.redirect,'error');return handler(url,options);};
}
async function main(){
 reset();let result=await notify('share-id','Please review <script>');
 assert.equal(result.sent,1);assert.equal(result.recipients[0].name,'Reader');assert.equal(result.recipients[0].status,'sent');assert.equal(calls.length,3);
 assert.equal(calls[1].url,'https://graph.microsoft.com/v1.0/chats');assert.equal(calls[1].body.chatType,'oneOnOne');assert.deepEqual(calls[1].body.members.map(m=>m['user@odata.bind']),[ownerId,readerId].map(id=>`https://graph.microsoft.com/v1.0/users('${id}')`));
 assert.equal(calls[2].url,'https://graph.microsoft.com/v1.0/chats/19%3Aexisting-chat%40thread.v2/messages');assert.equal(calls[2].body.body.contentType,'text');assert.match(calls[2].body.body.content,/https:\/\/test.example.com\/canvas\/shared\/share-id/);assert.match(calls[2].body.body.content,/Please review <script>/);assert.equal(lookups,3);
 reset();authToken.graphScopes='User.Read https://graph.microsoft.com/Chat.Create https://graph.microsoft.com/ChatMessage.Send';result=await notify('share-id');assert.equal(result.sent,1,'fully qualified Graph scopes must be accepted');
 reset();authToken.graphScopes='https://untrusted.example/Chat.Create https://untrusted.example/ChatMessage.Send';result=await notify('share-id');assert.equal(result.unavailable,1);assert.equal(calls.length,0);
 reset();authToken.padding='x'.repeat(6000);result=await notify('share-id');assert.equal(result.sent,1,'chunked encrypted session cookies must work');
 reset();result=await notifyRequest(new Request('https://test.example.com',{headers:{Cookie:'__Secure-next-auth.session-token=tampered'}}),'share-id');assert.equal(result.unavailable,1);assert.equal(calls.length,0);
 reset();const bearer=await require('next-auth/jwt').encode({token:authToken,secret:process.env.NEXTAUTH_SECRET});
 result=await notifyRequest(new Request('https://test.example.com',{headers:{Authorization:`Bearer ${bearer}`}}),'share-id');assert.equal(result.unavailable,1);assert.equal(calls.length,0,'personal sharing must never accept a bearer token');
 for(const adjust of [()=>process.env.CANVAS_TEAMS_PERSONAL_NOTIFICATIONS_ENABLED='false',()=>authToken=null,()=>authToken.graphScopes='User.Read',()=>authToken.graphProvider='github',()=>authToken.accessTokenExpiresAt=1,()=>authToken.refreshError='failed']) {
  reset();adjust();result=await notify('share-id');assert.equal(result.sent,0);assert.equal(result.unavailable,1);assert.equal(result.recipients[0].status,'permission_required');assert.equal(calls.length,0);
 }
 reset();authToken.salesforcePrincipal=reader.principal;result=await notify('share-id');assert.equal(result.failed,1);assert.equal(calls.length,0);
 reset();handler=async()=>Response.json({id:readerId});result=await notify('share-id');assert.equal(result.failed,1);assert.equal(calls.length,1);
 for(const failure of [401,403,429,500]) {
  reset();handler=async url=>url.includes('/me?')?Response.json({id:ownerId}):url.endsWith('/chats')?Response.json({id:'existing'}):new Response(null,{status:failure});
  result=await notify('share-id');assert.equal(result.sent,0);assert.equal(result.recipients[0].status,[401,403].includes(failure)?'permission_required':'failed');assert.equal(calls.length,3,'do not automatically retry a potentially accepted message');
 }
 reset();failLookup=3;result=await notify('share-id');assert.equal(result.failed,1);assert.equal(calls.length,2,'revocation after chat creation must prevent message delivery');
 reset();targets.readers=[reader,{...reader,principal:`${tenant}:44444444-4444-4444-4444-444444444444`,email:'second@example.com',name:'Second'}];
 let posts=0;handler=async url=>url.includes('/me?')?Response.json({id:ownerId}):url.endsWith('/chats')?Response.json({id:'existing'}):++posts===1?new Response(null,{status:403}):Response.json({id:'sent'});
 result=await notify('share-id');assert.equal(result.sent,1);assert.equal(result.unavailable,1);assert.deepEqual(result.recipients.map(r=>r.status),['permission_required','sent']);
 reset();targets.readers=[{...reader,principal:`44444444-4444-4444-4444-444444444444:${readerId}`}];result=await notify('share-id');assert.equal(result.failed,1);assert.equal(calls.length,1,'cross-tenant recipients must not create chats');
 reset();targets.unavailableReaders=[{...reader,name:'Removed',email:'removed@example.com'}];result=await notify('share-id');assert.equal(result.failed,1);assert.equal(result.sent,1);assert.equal(result.recipients[0].name,'Removed');
 reset();result=await notify('share-id','x'.repeat(4001));assert.equal(result.failed,1);assert.equal(calls.length,0);
 reset();process.env.NEXTAUTH_URL='http://unsafe.example.com';result=await notify('share-id');assert.equal(result.failed,1);assert.equal(calls.length,0);
 const {canvasNotificationNotice}=load('features/canvas/canvas-share-dialog.tsx',{'./canvas-fetch':{},react:{},'@/features/ui/dialog':{}});
 const notice=canvasNotificationNotice({channel:'personal',sent:1,failed:1,unavailable:1,recipients:[{name:'A',status:'sent'},{name:'B',status:'failed'},{name:'C',status:'permission_required'}]});
 assert.match(notice,/A：送信済み/);assert.match(notice,/B：失敗/);assert.match(notice,/C：権限なし/);assert.ok(!notice.includes('BOT未登録'));
 // Verify both Web entry points and the authenticated embedded/BOT route separately.
 let personalCalls=0,botCalls=0,saves=0;
 const routeStubs={
  '@/features/canvas/shared-canvas-service':{changeSharedCanvas:async()=>{saves++;return {enabled:true};},publishSavedCanvas:async()=>{saves++;return {id:'share-id',enabled:true};}},
  '@/features/teams/teams-canvas-dialog':{withCanvasRequest:async(request,id,fn)=>fn()},
  '@/features/canvas/shared-canvas-http':{requireCanvasOrigin(){},canvasShareInput:request=>request.json(),sharedCanvasHeaders:{'Cache-Control':'private, no-store'},canvasShareFailure:error=>{throw error;}},
  '@/features/canvas/canvas-personal-notifications':{notifyPersonalCanvasShare:async(request,id)=>{assert.ok(request instanceof Request);assert.equal(id,'share-id');personalCalls++;return {channel:'personal',sent:1};}},
  '@/features/teams/teams-canvas-notifications':{notifyTeamsCanvasShare:async()=>{botCalls++;return {sent:1};}}
 };
 const byId=load('app/(authenticated)/api/canvas/shared/[id]/route.ts',routeStubs),fromThread=load('app/(authenticated)/api/canvas/shared/from-thread/route.ts',routeStubs);
 const request=(embedded=false,notifyTeams=true)=>new Request('https://test.example.com/api/canvas/shared/share-id',{method:'PUT',headers:embedded?{Authorization:'Bearer scoped-dialog'}:{},body:JSON.stringify({action:'access',enabled:true,notifyTeams})});
 let response=await byId.PUT(request(),{params:{id:'share-id'}});assert.equal((await response.json()).notifications.channel,'personal');
 await byId.PUT(request(true),{params:{id:'share-id'}});assert.equal(personalCalls,1);assert.equal(botCalls,1);
 await byId.PUT(request(false,false),{params:{id:'share-id'}});assert.equal(personalCalls,1);
 await fromThread.POST(request());assert.equal(personalCalls,2);assert.equal(botCalls,1);assert.equal(saves,4);
 // Scope requests are gated and preserve Web meeting scopes. Credentials stay in the JWT.
 Object.assign(process.env,{AZURE_AD_CLIENT_ID:'test-client',AZURE_AD_CLIENT_SECRET:'test-secret'});
 const authStubs={'next-auth':{},'next-auth/providers/azure-ad':{default:config=>({id:'azure-ad',...config})},'next-auth/providers/credentials':{default:()=>({})},'next-auth/providers/github':{default:()=>({})},'@/features/auth-page/helpers':{},'@/lib/sl-dept':{},'./salesforce-principal':{salesforcePrincipalFromProfile:()=>owner.principal}};
 process.env.CANVAS_TEAMS_PERSONAL_NOTIFICATIONS_ENABLED='false';
 let authOptions=load('features/auth-page/auth-api.ts',authStubs).options;
 assert.ok(!authOptions.providers.find(p=>p.id==='azure-ad').authorization.params.scope.includes('Chat.Create'));
 process.env.CANVAS_TEAMS_PERSONAL_NOTIFICATIONS_ENABLED='true';
 authOptions=load('features/auth-page/auth-api.ts',authStubs).options;
 assert.match(authOptions.providers.find(p=>p.id==='azure-ad').authorization.params.scope,/Chat.Create ChatMessage.Send/);
 for(const meeting of ['false','true'])for(const chat of ['false','true']) {
  process.env.DESKNETS_WEB_MEETING_ENABLED=meeting;process.env.CANVAS_TEAMS_PERSONAL_NOTIFICATIONS_ENABLED=chat;
  const configured=load('features/auth-page/auth-api.ts',authStubs).options.providers.find(p=>p.id==='azure-ad').authorization.params.scope.split(' ');
  assert.equal(configured.includes('Calendars.ReadWrite'),meeting==='true');assert.equal(configured.includes('OnlineMeetings.Read'),meeting==='true');assert.equal(configured.includes('Chat.Create'),chat==='true');assert.equal(configured.includes('ChatMessage.Send'),chat==='true');
 }
 let token=await authOptions.callbacks.jwt({token:{},profile:{},account:{provider:'azure-ad',access_token:'access',expires_at:Date.now()/1000+3600,scope:'User.Read Chat.Create ChatMessage.Send'}});
 assert.equal(token.graphProvider,'azure-ad');assert.match(token.graphScopes,/ChatMessage.Send/);
 const refreshedScopes='User.Read Chat.Create';
 token.accessTokenExpiresAt=1;token.refreshToken='refresh';
 global.fetch=async(url,options)=>{assert.ok(options.body.get('scope').includes('ChatMessage.Send'));return Response.json({access_token:'new-token',expires_in:3600,scope:refreshedScopes});};
 token=await authOptions.callbacks.jwt({token});assert.equal(token.graphScopes,refreshedScopes);
 const webSession=await authOptions.callbacks.session({session:{user:{}},token});assert.equal(webSession.graphScopes,refreshedScopes);
 assert.equal(Object.hasOwn(webSession,'accessToken'),false);assert.equal(Object.hasOwn(webSession,'refreshToken'),false);
 assert.ok(!JSON.stringify(webSession).includes(token.accessToken));assert.ok(!JSON.stringify(webSession).includes('"refresh"'));
 const errorSession=await authOptions.callbacks.session({session:{user:{}},token:{...token,refreshError:{access_token:'private-error-token'}}});
 assert.ok(!JSON.stringify(errorSession).includes('private-error-token'),'OAuth error details must not publish credentials');
 console.log('PASS personal Canvas notifications: delegated sender, no BOT dependency, least scopes, feature gate, per-recipient results, owner mismatch, ACL revocation, tenant restriction, no retries, plain text, UI notices');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
