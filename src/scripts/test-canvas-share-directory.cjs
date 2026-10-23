const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const tenant='11111111-1111-1111-1111-111111111111',principal=tenant+':22222222-2222-2222-2222-222222222222';
let data={ok:true,items:[]},status=200,checks=0;
const user={salesforcePrincipal:principal,email:'owner@example.com'};
const mod={exports:{}};
const stubs={'server-only':{},'./canvas-actor':{getCanvasActor:async()=>user},'@/features/common/services/salesforce-access':{isSalesforceAllowedEmail:email=>email.endsWith('@example.com')},'@/features/common/services/salesforce-personal':{personalSalesforceBase:()=>new URL('https://personal.example.com'),signSalesforceRequest:input=>{assert.equal(input.principal,principal);assert.equal(input.url.pathname,'/api/sf/share_people');return {'X-AC-Identity':'signed'};},assertPersonalSalesforceResponse:()=>{checks++;}},'./shared-canvas-service':{CanvasShareError:class extends Error{constructor(status,message){super(message);this.status=status;}}}};
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../features/canvas/share-directory.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
new Function('require','module','exports','fetch',code)(id=>stubs[id]??require(id),mod,mod.exports,async(url,options)=>{assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');return Response.json(data,{status});});
(async()=>{
 Object.assign(process.env,{SF_PERSONAL_AUTH_METHOD:'oauth',SF_PERSONAL_SNAPSHOT_POLICY:'strict'});
 const read=mod.exports.salesforceShareDirectory;
 data.items=[{principal,email:'owner@example.com',name:'野元 潤一',department:'営業部'},{principal:principal.replace(tenant,'99999999-9999-9999-9999-999999999999'),email:'cross@example.com',name:'Cross',department:'Other'}];
 let users=await read();assert.equal(users.length,1);assert.equal(users[0].department,'営業部');assert.equal(checks,1);
 data.items.push({...data.items[0]});await assert.rejects(read,e=>e.status===503);data.items.pop();
 data.items[0].department=42;await assert.rejects(read,e=>e.status===503);
 status=403;await assert.rejects(read,e=>e.status===503);
 status=200;data={ok:true,items:[]};assert.deepEqual(await read(),[],'no stale directory fallback when membership disappears');
 console.log('PASS SF sharing directory: signed personal request, SF department, same tenant/allowlist, duplicate/schema refusal, failure closed and no stale membership');
})().catch(error=>{console.error(error);process.exitCode=1;});
