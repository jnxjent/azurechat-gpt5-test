const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../features/canvas/canvas-share-dialog.tsx'),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
async function scenario({dirty=true,enabled=true,fail=false}={}) {
  let index=0,saves=0;const calls=[],errors=[];
  const values=[{id:'share',revision:2,readers:['reader@example.com'],enabled:true},['reader@example.com'],enabled,false,false,'',''];
  const react={useEffect(){},useState(){const i=index++;return [values[i],value=>{if(i===5)errors.push(value);}];}};
  const module={exports:{}};
  const request=async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({...values[0],enabled})};};
  new Function('require','module','exports','fetch','window',js)(id=>id==='react'?react:id==='@/features/ui/dialog'?new Proxy({},{get:(_,key)=>key}):require(id),module,module.exports,request,{location:{origin:'https://test.example.com'}});
  const tree=module.exports.CanvasShareDialog({threadId:'thread',version:3,dirty,saveCanvas:async()=>{saves++;if(fail)throw Error('save failed');return 4;},onClose(){}});
  function find(node){if(!node||typeof node!=='object')return null;if(node.type==='button'&&node.props.children===(enabled?'共有を保存':'共有を解除'))return node;for(const child of [node.props?.children].flat(Infinity)){const found=find(child);if(found)return found;}return null;}
  const button=find(tree);assert.ok(button);assert.equal(button.props.disabled,false);
  button.props.onClick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(saves,dirty&&enabled?1:0);
  if(fail){assert.equal(calls.length,0);assert.ok(errors.includes('save failed'));}
  else {assert.equal(calls.length,1);assert.equal(calls[0].version,dirty&&enabled?4:3);assert.equal(calls[0].enabled,enabled);}
}
(async()=>{await scenario();await scenario({fail:true});await scenario({dirty:false});await scenario({enabled:false});console.log('PASS Canvas sharing: save before publish, returned version, save failure blocks publish, clean canvas, revoke without saving');})().catch(error=>{console.error(error);process.exitCode=1;});
