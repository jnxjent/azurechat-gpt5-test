const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file, overrides={}) {
 const m={exports:{}};
 const js=ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 new Function('require','module','exports',js)(id=>{
  if(id in overrides)return overrides[id];
  if(id.startsWith('node:'))return require(id);
  if(id.startsWith('.'))return load(path.join(path.dirname(file),id+'.ts'),overrides);
  throw Error(id);
 },m,m.exports);return m.exports;
}
const {allowsLibrarySearch:allowed}=load('features/chat-page/chat-services/chat-api/document-source-policy.ts');
assert.equal(allowed('廃棄物業界上位5社はどこですか？',[]),false);
assert.equal(allowed('廃棄物業界が二極化するのはなぜ？',[]),false);
assert.equal(allowed('SharePointの決算説明資料を要約して',[]),true);
assert.equal(allowed('営業方針を調べて',['AISearch']),true);
assert.equal(allowed('添付資料を要約して',[]),true);
assert.equal(allowed('社内規程を検索して',[]),true);
assert.equal(allowed('一般的な質問',['BraveSearch']),false);
assert.equal(allowed('営業方針',[],true),true);
let calls=0,sent;
const contents=[{title:'業界上位企業',kind:'bullets',bullets:['A社、B社']},{title:'業界上位企業',kind:'table',table:{columns:['企業','特徴'],rows:[['A社','回収'],['B社','処理']]},caveats:['順位ではなく主要企業の例']}];
const {executePptxStructureEdit}=load('features/pptx/structure-edit-service.ts',{
 'server-only':{},
 '@/features/common/services/openai':{OpenAIPptInstance:()=>({chat:{completions:{create:async()=>({choices:[{message:{content:JSON.stringify({slides:[contents[Math.min(calls++,1)]]})}}]})}}})},
 '@/features/chat-page/chat-services/chat-message-service':{FindTopChatMessagesForCurrentUser:async()=>({status:'OK',response:[{role:'assistant',content:'A社 回収。B社 処理。順位ではなく主要企業の例'}]})},
});
global.fetch=async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({ok:true,downloadUrl:'https://example.invalid/output.pptx',totalSlides:4,changedSlideIndices:[3]})};};
(async()=>{
 const result=await executePptxStructureEdit({intent:{kind:'add_slide',count:1,requestedCount:1,blank:false,unsupported:[]},instruction:'「業界上位企業」スライドを1枚追加してください',fileUrl:'https://example.invalid/input.pptx',threadId:'test',baseUrl:'http://localhost:3000',outputBaseName:'test'});
 assert.equal(calls,2,'bullets trigger one correction before creating a file');
 assert.equal(sent.structureOps[0].kind,'table');assert.equal(sent.structureOps[0].table.rows.length,2);
 assert.deepEqual(sent.structureOps[0].caveats,['順位ではなく主要企業の例']);
 assert.ok(result.downloadUrl);
 console.log('PASS actual company-add request retries paragraph output; source policy keeps public questions out of SharePoint');
})().catch(e=>{console.error(e);process.exitCode=1;});
