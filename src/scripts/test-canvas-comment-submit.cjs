const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
function harness(file,initial=[],stubs={}) {
  let cursor=0;const states=[...initial],refs=[];
  const react={useState(value){const i=cursor++;if(!(i in states))states[i]=value;return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v;}];},useRef(value){const i=cursor++;return refs[i]??(refs[i]={current:value});},useCallback:fn=>fn,useEffect(){}};
  stubs['./shared-canvas-editor']??={SharedCanvasEditor:()=>null};
  stubs['./canvas-fetch']??={canvasFetch:(...args)=>global.fetch(...args)};
  const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const mod={exports:{}};new Function('require','module','exports',code)(id=>id==='react'?react:id in stubs?stubs[id]:require(id),mod,mod.exports);
  return {states,exports:mod.exports,render(fn){cursor=0;return fn();}};
}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of [node.props?.children].flat(Infinity)){const result=find(child,predicate);if(result)return result;}return null;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function main(){
  const ui=harness('features/canvas/canvas-comments.tsx');let pending,calls=[];
  const props={comments:[],canComment:true,busy:false,onChange:input=>{calls.push(input);return new Promise(resolve=>{pending=resolve;});}};
  const render=()=>ui.render(()=>ui.exports.CanvasComments(props));
  find(render(),n=>n.type==='textarea').props.onChange({target:{value:'keep my draft'}});
  let form=find(render(),n=>n.type==='form');form.props.onSubmit({preventDefault(){}});form.props.onSubmit({preventDefault(){}});
  assert.equal(calls.length,1,'synchronous double click must post once');const firstId=calls[0].requestId;
  pending(false);await tick();assert.equal(find(render(),n=>n.type==='textarea').props.value,'keep my draft');
  find(render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.equal(calls[1].requestId,firstId,'network retry retains submission identity');
  pending(true);await tick();assert.equal(find(render(),n=>n.type==='textarea').props.value,'','only confirmed success clears draft');
  find(render(),n=>n.type==='textarea').props.onChange({target:{value:'new post'}});
  find(render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.notEqual(calls[2].requestId,firstId);pending(true);await tick();
  assert.equal(render().props.id,'comments');
  // The Web view applies the returned committed comment immediately, without
  // needing a save click or a second GET to succeed.
  const document={threadId:'thread',title:'report',content:'body',tableIndex:0};
  const report={revision:2,updatedAt:'old',owner:true,document,restricted:false,comments:[],canComment:true};
  const comment={id:'comment',body:'saved',authorName:'owner',deleted:false};
  let requests=0;global.fetch=async()=>{requests++;return {ok:true,json:async()=>({revision:3,updatedAt:'new',comment})};};
  function Comments(){}
  const view=harness('features/canvas/shared-canvas-view.tsx',[report,'','',false,'',null,null,null],{'react-markdown':{default:()=>null},'remark-gfm':{default:()=>{}},'./canvas-panel':{CanvasChart:()=>null},'./canvas-rules':{canvasTables:()=>[]},'./canvas-share-dialog':{CanvasPeoplePicker:()=>null},'./canvas-report-layout':{canvasReportLayout:()=>({title:'report',body:'body'})},'./canvas-comments':{CanvasComments:Comments}});
  const tree=view.render(()=>view.exports.SharedCanvasView({id:'id'}));
  assert.equal(await find(tree,n=>n.type===Comments).props.onChange({action:'create',body:'saved',requestId:firstId}),true);
  assert.equal(requests,1);assert.equal(view.states[0].comments[0].body,'saved');assert.equal(view.states[0].revision,3);
  assert.ok(find(tree,n=>n.type==='a'&&n.props.href==='#comments'));
  const previousNavigator=Object.getOwnPropertyDescriptor(global,'navigator'),previousWindow=global.window;let copied;
  Object.defineProperty(global,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>{copied=value;}}}});
  global.window={location:{origin:'https://test.example.com',href:'https://test.example.com/teams/canvas'}};
  find(tree,n=>n.type==='button'&&n.props.children==='共有URLをコピー').props.onClick();await tick();
  assert.equal(copied,'https://test.example.com/canvas/shared/id','copy the canonical report link, never the Teams dialog URL');
  if(previousNavigator)Object.defineProperty(global,'navigator',previousNavigator);else delete global.navigator;global.window=previousWindow;
  let posted=[];
  global.fetch=async(url,options)=>{
    if(!options?.method)return {ok:true,json:async()=>({...report,revision:3,comments:[{id:'other',body:'another user'}]})};
    posted.push(JSON.parse(options.body));
    return posted.length===1?{ok:false,status:409,json:async()=>({error:'stale'})}:{ok:true,json:async()=>({revision:4,updatedAt:'new',comment})};
  };
  const tree2=view.render(()=>view.exports.SharedCanvasView({id:'id'}));
  assert.equal(await find(tree2,n=>n.type===Comments).props.onChange({action:'create',body:'saved',requestId:firstId}),true);
  assert.equal(posted.length,2);assert.equal(posted[1].revision,3);assert.equal(posted[0].requestId,posted[1].requestId);assert.equal(view.states[0].comments.length,2);
  // A new Teams-created report starts disabled. Picking a recipient is an
  // explicit sharing action and must enable it before saving/notifying.
  const priorDocument=global.document;global.document={hidden:false};
  async function sharingScenario({notify=true,disable=false,receipt={sent:1,unavailable:0,failed:0}}={}) {
    let saved;
    const initial={...report,enabled:false,readers:[]};
    global.fetch=async(url,options)=>{
      if(options?.method==='PUT'){saved=JSON.parse(options.body);return {ok:true,json:async()=>({revision:3,enabled:saved.enabled,notifications:saved.enabled&&saved.notifyTeams?receipt:undefined})};}
      return {ok:true,json:async()=>({...initial,revision:3,enabled:saved.enabled,readers:saved.readers})};
    };
    const panel=harness('features/canvas/shared-canvas-view.tsx',[initial,'','',false,'',null,null,null,false,'',notify],{'react-markdown':{default:()=>null},'remark-gfm':{default:()=>{}},'./canvas-panel':{CanvasChart:()=>null},'./canvas-rules':{canvasTables:()=>[]},'./canvas-share-dialog':{CanvasPeoplePicker:()=>null,canvasNotificationNotice:v=>v?`Teams通知：送信${v.sent}件・BOT未登録等${v.unavailable}件・失敗${v.failed}件。`:''},'./canvas-report-layout':{canvasReportLayout:()=>({title:'report',body:'body'})},'./canvas-comments':{CanvasComments:Comments}});
    const renderPanel=()=>panel.render(()=>panel.exports.SharedCanvasView({id:'id',embedded:true}));
    find(renderPanel(),n=>n.type==='button'&&n.props.children==='共有').props.onClick();
    assert.equal(find(renderPanel(),n=>n.type==='button'&&n.props.children==='共有設定を保存').props.disabled,true,'enabled sharing needs a recipient');
    find(renderPanel(),n=>Array.isArray(n.props?.selected)&&typeof n.props.onChange==='function').props.onChange(['reader@example.com']);
    assert.equal(panel.states[6],true,'recipient selection enables sharing');
    if(disable)panel.states[6]=false;
    const save=find(renderPanel(),n=>n.type==='button'&&n.props.children==='共有設定を保存');assert.equal(save.props.disabled,false);save.props.onClick();await tick();
    assert.equal(saved.enabled,!disable);assert.equal(saved.notifyTeams,notify);assert.deepEqual(saved.readers,['reader@example.com']);
    const local=find(renderPanel(),n=>n.type==='p'&&n.props.className==='rounded border bg-muted p-3');assert.ok(local,'result is visible next to the save controls');
    assert.ok(local.props.children.includes(disable?'通知は送っていません':!notify?'オフ':`送信${receipt.sent}件`));
  }
  await sharingScenario();await sharingScenario({receipt:{sent:0,unavailable:1,failed:0}});await sharingScenario({notify:false});await sharingScenario({disable:true});
  global.document=priorDocument;
  const editor=harness('features/canvas/shared-canvas-editor.tsx');let saved,closed=0,saveOK=false;
  const editorProps={document:{...document,unit:'円',period:'2026-01',chartType:'bar',valueColumn:1},busy:false,onCancel:()=>closed++,onSave:async input=>{saved=input;return saveOK;}};
  const editTree=()=>editor.render(()=>editor.exports.SharedCanvasEditor(editorProps));
  find(editTree(),n=>n.type==='textarea').props.onChange({target:{value:'edited body'}});
  find(editTree(),n=>n.type==='form').props.onSubmit({preventDefault(){}});await tick();assert.equal(closed,0);assert.equal(find(editTree(),n=>n.type==='textarea').props.value,'edited body');
  saveOK=true;find(editTree(),n=>n.type==='form').props.onSubmit({preventDefault(){}});await tick();assert.equal(closed,1);assert.equal(saved.content,'edited body');assert.equal(saved.threadId,undefined);assert.equal(saved.source,undefined);
  console.log('PASS comment submission: one-click persistence, immediate Web display, failed draft retention, retry identity, double-click lock, comment navigation');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
