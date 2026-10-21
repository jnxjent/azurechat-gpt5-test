const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict');
const file=path.resolve(__dirname,'../features/common/services/salesforce-clarification-stream.ts');
const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const loaded={exports:{}};
new Function('require','module','exports',source)(id=>id==='server-only'?{}:require(id),loaded,loaded.exports);
(async()=>{
 const question='対象会社を選択してください。';
 const runner=loaded.exports.salesforceClarificationStream(question,new AbortController().signal);
 const content=await runner.finalContent();
 assert.equal(content,'検索条件の確認：\n\n'+question);
 assert.ok(!content.includes('氏名'));assert.ok(!content.includes('チーム名'));assert.ok(!content.includes('svg'));
 console.log('PASS Salesforce clarification: actual stream preserves the exact question without an AI call');
 await require('./test-salesforce-multiturn-stream.cjs');
})().catch(error=>{console.error(error);process.exitCode=1;});
