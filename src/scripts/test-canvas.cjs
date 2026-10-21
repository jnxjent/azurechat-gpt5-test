const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
let owner='a',etag=0,conflict=false;
let proposedContent='## 結論\n元データを確認してください。\n## 修正案';
const documents=new Map();
const stubs={
  'server-only':{},
  '@/features/ui/dropdown-menu':{},
  'react-markdown':()=>null,
  'remark-gfm':()=>{},
  '@/features/common/services/openai':{OpenAIInstance:()=>({chat:{completions:{create:async()=>({choices:[{finish_reason:'stop',message:{content:proposedContent}}]})}}})},
  '@/features/auth-page/helpers':{userHashedId:async()=>{if(!owner)throw Error('User not found');return owner;}},
  '@/features/chat-page/chat-services/models':{CHAT_THREAD_ATTRIBUTE:'CHAT_THREAD'},
  '@/features/common/services/cosmos':{HistoryContainer:()=>({
    items:{query(spec,options){assert.equal(options.partitionKey,owner);const params=Object.fromEntries(spec.parameters.map(x=>[x.name,x.value]));assert.equal(params['@user'],owner);return {fetchAll:async()=>({resources:params['@type']==='USER_CANVAS'?[...documents.values()].filter(d=>d.userId===owner):owner==='a'&&(!params['@id']||params['@id']==='thread-a')?[{id:'thread-a'}]:[]})};},async create(item){const k=owner+'/'+item.id;if(documents.has(k))throw {code:409};documents.set(k,{...item,_etag:String(++etag)});}},
    item(id,user){assert.equal(user,owner);const k=user+'/'+id;return {async read(){if(!documents.has(k))throw {code:404};return {resource:structuredClone(documents.get(k))};},async replace(item,options){assert.equal(options.accessCondition.condition,documents.get(k)._etag);if(conflict)throw {code:412};documents.set(k,{...item,_etag:String(++etag)});},async delete(options){assert.equal(options.accessCondition.condition,documents.get(k)._etag);documents.delete(k);}};}
  })}
};
const cache=new Map();
function load(file){
  file=path.resolve(__dirname,'..',file);
  if(cache.has(file))return cache.get(file);
  const module={exports:{}};cache.set(file,module.exports);
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  new Function('require','module','exports',js)(id=>stubs[id]??(id==='./canvas-update'?load('features/canvas/canvas-update.ts'):id==='./canvas-export'?{}:id==='./canvas-rules'?load('features/canvas/canvas-rules.ts'):id.startsWith('@/features/canvas/')?load(id.slice(2)+'.ts'):require(id)),module,module.exports);
  return module.exports;
}
const rules=load('features/canvas/canvas-rules.ts');
const api=load('app/(authenticated)/api/canvas/route.ts');
const service=load('features/canvas/canvas-service.ts');
const {updateCanvas}=load('features/canvas/canvas-update.ts');
const rewrite=load('app/(authenticated)/api/canvas/rewrite/route.ts');
async function main(){
  for(const text of ['', '-', '未取得', 'N/A', '12円','1,2','Infinity','NaN','12%'])assert.equal(rules.canvasNumber(text),null,text);
  assert.equal(rules.canvasNumber('0'),0);assert.equal(rules.canvasNumber('-1,250.5'),-1250.5);assert.equal(rules.canvasNumber('１２３'),123);
  const content='| 月 | 売上 |\n| --- | --- |\n| 4月 | 100 |\n| 5月 | 未取得 |\n| 6月 | 0 |';
  const table=rules.canvasTables(content)[0];assert.equal(table.rows.length,3);assert.deepEqual(table.rows.map(r=>rules.canvasNumber(r[1])),[100,null,0]);
  assert.equal(rules.canvasTables('```\n'+content+'\n```').length,0);
  assert.equal(rules.canvasTables(content+'\n\n'+content).length,2);
  assert.deepEqual(rules.canvasMetadataSuggestions('- **単位**：万円\n- **対象期間**：2026年4月〜9月\n- **出典**：架空データ'),{unit:'万円',period:'2026年4月〜9月',source:'架空データ'});
  assert.equal(rules.canvasMetadataSuggestions('単位：円\n単位：万円').unit,'','ambiguous units are not guessed');
  assert.equal(rules.canvasMetadataSuggestions('```\n単位：円\n```').unit,'');
  assert.equal(rules.canvasMetadataSuggestions('出典：未取得').source,'');
  assert.equal(rules.canvasMetadataSuggestions('売上は123万円だった。').unit,'','unlabelled prose is not guessed');
  const {CanvasChart,CanvasSuggestionInput}=load('features/canvas/canvas-panel.tsx');
  let accepted='';
  const suggestionProps={value:'',suggestion:'万円',onChange:value=>{accepted=value;},className:'',maxLength:40,placeholder:'例',id:'unit'};
  let suggestionInput=CanvasSuggestionInput(suggestionProps).props.children[0];
  assert.equal(suggestionInput.props.placeholder,'万円');
  suggestionInput.props.onKeyDown({key:'Tab',shiftKey:true,nativeEvent:{}});assert.equal(accepted,'');
  suggestionInput.props.onKeyDown({key:'Tab',shiftKey:false,nativeEvent:{isComposing:true}});assert.equal(accepted,'');
  suggestionInput.props.onKeyDown({key:'Tab',shiftKey:false,nativeEvent:{}});assert.equal(accepted,'万円');
  accepted='';suggestionInput=CanvasSuggestionInput({...suggestionProps,value:'円'}).props.children[0];
  suggestionInput.props.onKeyDown({key:'Tab',shiftKey:false,nativeEvent:{}});assert.equal(accepted,'','manual values are never overwritten by Tab');
  const {renderToStaticMarkup}=require('react-dom/server');
  const React=require('react');
  const line=renderToStaticMarkup(React.createElement(CanvasChart,{table,column:1,type:'line',unit:'円'}));
  assert.equal((line.match(/<circle /g)||[]).length,2,'only real numeric values have points, including actual zero');
  assert.ok(!/<line [^>]*stroke="#578cd6"/.test(line),'line does not connect across a missing value');
  const bar=renderToStaticMarkup(React.createElement(CanvasChart,{table,column:1,type:'bar',unit:'円'}));
  assert.equal((bar.match(/<rect /g)||[]).length,2);
  const comparison={headers:['月','今年','前年'],rows:[['4月','100','80'],['5月','未取得','0'],['6月','0','-20']]};
  const multi=renderToStaticMarkup(React.createElement(CanvasChart,{table:comparison,column:1,columns:[1,2],type:'bar',unit:'万円'}));
  assert.equal((multi.match(/<rect /g)||[]).length,5,'comparison preserves missing versus actual zero across all series');
  assert.ok(multi.includes('#578cd6')&&multi.includes('#41c3ed'),'light-mode comparison follows the supplied palette');
  assert.ok(line.includes('fill="#578cd6"')&&bar.includes('fill="#578cd6"'),'light-mode bars and line points use the same blue');
  const dark=renderToStaticMarkup(React.createElement(CanvasChart,{table:comparison,column:1,columns:[1,2],type:'bar',unit:'円',colorMode:'dark'}));
  assert.ok(dark.includes('#22c55e')&&dark.includes('#38bdf8')&&!dark.includes('#578cd6'),'dark-mode colors remain unchanged');
  const barsFor=(mode)=>renderToStaticMarkup(React.createElement(CanvasChart,{table:{headers:['Month','Amount'],rows:Array.from({length:11},(_,i)=>[String(i),String(i+1)])},column:1,type:'bar',unit:'JPY',colorMode:mode})).match(/<rect [^>]+>/g).map(rect=>rect.match(/fill="([^"]+)"/)[1]);
  const lightBars=barsFor('light');
  assert.deepEqual(lightBars.slice(0,9),['#578cd6','#41c3ed','#02b880','#e9b542','#e20d5b','#a251b3','#e57f32','#00be9d','#95a5a6']);
  assert.equal(lightBars[9],lightBars[0],'category colors cycle');
  assert.deepEqual([...new Set(barsFor('dark'))],['#22c55e'],'dark single-series bars stay unchanged');
  const input={threadId:'thread-a',title:'売上レポート',content,unit:'円',period:'2026年4月〜6月',source:'テスト資料',chartType:'bar',tableIndex:0,valueColumn:1,version:0};
  const proposed={base:JSON.stringify(input),content:'## 結論\n取得済み月のみの評価です。'};
  const calls=[];
  const request=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json(url.endsWith('/rewrite')?{content:proposed.content}:{item:{...JSON.parse(options.body),version:1}});};
  const oneClick=await updateCanvas(input,'結論を先頭にして',request);
  assert.deepEqual(calls.map(c=>c.url),['/api/canvas/rewrite','/api/canvas']);
  assert.equal(calls[1].body.content,proposed.content);assert.equal(oneClick.content,proposed.content);
  calls.length=0;await updateCanvas(input,'',request);assert.deepEqual(calls.map(c=>c.url),['/api/canvas'],'plain save must not invoke AI');
  let failures=0;await assert.rejects(()=>updateCanvas(input,'修正して',async()=>{failures++;return Response.json({error:'AI failed'},{status:500});}),/AI failed/);assert.equal(failures,1,'AI failure must not save the old document');
  const updated=rules.canvasUpdateDocument(input,proposed);
  assert.equal(updated.content,proposed.content,'update must save the pending proposal, not the old report');
  assert.throws(()=>rules.canvasUpdateDocument({...input,title:'changed'},proposed));
  let navigation=rules.canvasStep({...updated,version:7},[input],[],'undo');
  assert.equal(navigation.doc.content,input.content);assert.equal(navigation.doc.version,7);
  navigation=rules.canvasStep(navigation.doc,navigation.past,navigation.future,'redo');
  assert.equal(navigation.doc.content,updated.content);assert.equal(navigation.doc.version,7);
  assert.equal(rules.canvasStep(input,[],[],'undo').doc,input,'empty history is a no-op');
  const propose=(document,instruction)=>rewrite.POST(new Request('http://localhost/api/canvas/rewrite',{method:'POST',body:JSON.stringify({document,instruction})}));
  let suggestion=await propose(input,'結論を先頭にして');assert.equal(suggestion.status,200);assert.ok((await suggestion.json()).content.includes('修正案'));assert.equal(documents.size,0,'AI proposal never saves automatically');
  proposedContent='## 概要\nあまり変わらない修正案';assert.equal((await propose(input,'結論を先頭にして')).status,422,'missing requested conclusion must be reported');
  proposedContent='## 結論\n元データを確認してください。\n## 修正案';
  assert.equal((await propose(input,'')).status,400);assert.equal((await propose({...input,threadId:'someone-else'},'修正して')).status,404);
  const put=value=>api.PUT(new Request('http://localhost/api/canvas',{method:'PUT',body:JSON.stringify(value)}));
  let response=await put({...input,userId:'other'});assert.equal(response.status,200);assert.equal(documents.size,1);
  const stored=[...documents.values()][0];assert.equal(stored.userId,'a');assert.equal(stored.version,1);
  response=await api.GET(new Request('http://localhost/api/canvas?threadId=thread-a'));assert.equal((await response.json()).item.content,content);
  assert.equal((await put(input)).status,409,'stale version cannot overwrite');
  conflict=true;assert.equal((await put({...input,version:1})).status,409,'etag race cannot overwrite');conflict=false;
  assert.equal((await put({...input,version:1,chartType:'line'})).status,200);
  let snapshots=await api.GET(new Request('http://localhost/api/canvas?threadId=thread-a&history=1'));
  assert.equal((await snapshots.json()).history[0].version,1);
  for(let version=2;version<9;version++)assert.equal((await put({...input,version,valueColumns:[1,2]})).status,200);
  snapshots=await api.GET(new Request('http://localhost/api/canvas?threadId=thread-a&history=1'));
  const history=(await snapshots.json()).history;assert.equal(history.length,5);assert.equal(history[0].version,8);
  assert.equal((await put({...input,version:9,valueColumns:[1,1]})).status,400,'duplicate series rejected');
  assert.equal((await put({...input,version:9,valueColumns:[1,2,3,4,5,6,7]})).status,400,'at most six series');
  const listed=await api.GET(new Request('http://localhost/api/canvas?list=1'));assert.equal((await listed.json()).items.length,1);
  owner='b';assert.equal((await api.GET(new Request('http://localhost/api/canvas?threadId=thread-a'))).status,404);
  assert.equal((await propose(input,'修正して')).status,404,'AI editing requires thread ownership');
  assert.equal((await (await api.GET(new Request('http://localhost/api/canvas?list=1'))).json()).items.length,0,'library is personal');
  assert.equal((await put(input)).status,404,'another user cannot write into this thread');
  owner='';assert.equal((await put(input)).status,401);
  owner='a';assert.equal((await put({...input,content:'x'.repeat(60001)})).status,400);
  const currentDoc={...input,version:9};
  const committed=rules.canvasUpdateDocument(currentDoc,{base:JSON.stringify(currentDoc),content:proposed.content});
  assert.equal((await put(committed)).status,200);
  const reopened=await (await api.GET(new Request('http://localhost/api/canvas?threadId=thread-a&history=1'))).json();
  assert.equal(reopened.item.content,proposed.content,'reopening returns the updated proposal');
  assert.equal(reopened.history[0].content,input.content,'the old report remains available for undo');
  assert.equal((await put({...input,chartType:'script'})).status,400);
  await service.deleteCanvasForThread('thread-a');assert.equal(documents.size,0);
  console.log('PASS Canvas: table parsing, missing vs zero, numeric validation, authenticated ownership, persistence, version/etag races, deletion and size limits');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
