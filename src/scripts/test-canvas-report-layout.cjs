const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
(async()=>{
 const {fromMarkdown}=await import('mdast-util-from-markdown');
 const module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../features/canvas/canvas-report-layout.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('require','module','exports',code)(()=>({fromMarkdown}),module,module.exports);
 const layout=module.exports.canvasReportLayout;
 let result=layout({title:'レポート',content:'<!-- sf-report -->\n# **J＆T環境** 月別商談金額\n\n単位：円'});
 assert.equal(result.title,'J＆T環境 月別商談金額');assert.ok(!result.body.includes('# **J＆T'));assert.ok(result.body.includes('単位：円'));
 result=layout({title:'レポート',content:'正式タイトル\n==========\n\n本文'});assert.equal(result.title,'正式タイトル');assert.ok(result.body.includes('本文'));
 result=layout({title:'手動で設定した名前',content:'# 元の見出し\n本文'});assert.equal(result.title,'手動で設定した名前');assert.ok(result.body.includes('元の見出し'));
 result=layout({title:'レポート',content:'本文\n\n## 詳細'});assert.equal(result.title,'レポート');assert.ok(result.body.includes('詳細'));
 // Comment bodies are plain text: HTML is escaped by React, not interpreted as Markdown/HTML.
 const mod={exports:{}};const jsx=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../features/canvas/canvas-comments.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','module','exports',jsx)(require,mod,mod.exports);
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const html=renderToStaticMarkup(React.createElement(mod.exports.CanvasComments,{comments:[{id:'one',authorName:'<img>',department:'Sales',body:'<script>alert(1)</script>',createdAt:'2026-10-23T00:00:00Z',updatedAt:'2026-10-23T00:00:00Z',reportVersion:1,mine:false,deleted:false}],canComment:false,busy:false,onChange:async()=>true}));
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('閲覧のみ'));
 console.log('PASS Canvas layout: parsed Markdown title before graph, inline formatting, Setext headings, explicit titles, body preservation; comment HTML escaping');
})().catch(error=>{console.error(error);process.exitCode=1;});
