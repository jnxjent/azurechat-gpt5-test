const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict');
function load(relative){const mod={exports:{}};const js=ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'..',relative),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;new Function('require','module','exports',js)(require,mod,mod.exports);return mod.exports;}
const {salesforceMonthlyReport,formatSalesforceAmount}=load('features/common/services/salesforce-account-selection.ts');
const {canvasTables,canvasNumber,canvasMetadataSuggestions,canvasImportedMetadata,canvasChatContext}=load('features/canvas/canvas-rules.ts');
function report(values,extra={}){return salesforceMonthlyReport({request_plan:{account_name:'J＆T環境',account_id:'001A70000058uKbIAI',dateRange:{start:'2026-01-01',end:'2026-03-31'},aggregation:{interval:'month',func:'SUM'}},analysis:{complete:true,items:values.map((value,i)=>({period:`2026-0${i+1}`,value,record_count:1})),...extra},items:[]},true);}
let text=report(['60000.0','23000.0']);
assert.ok(text.includes('対象期間の商談合計金額：83,000 円'));
assert.deepEqual(canvasTables(text)[0].rows.map(row=>canvasNumber(row[1])),[60000,23000]);
assert.equal(canvasImportedMetadata(text).unit,'円');
assert.ok(report(['999999999']).includes('999,999,999 円'));
text=report(['1000000000']);assert.ok(text.includes('1,000,000 千円'));assert.equal(canvasTables(text)[0].rows[0][1],'1,000,000');assert.equal(canvasImportedMetadata(text).unit,'千円');
text=report(['600000000','400000000']);assert.ok(text.includes('1,000,000 千円'));assert.deepEqual(canvasTables(text)[0].rows.map(row=>canvasNumber(row[1])),[600000,400000]);
assert.equal(formatSalesforceAmount('1000000000.50',true),'1,000,000.0005');
assert.equal(formatSalesforceAmount('-1234567.8900'),'-1,234,567.89');
assert.equal(formatSalesforceAmount('0.000'), '0');
assert.equal(formatSalesforceAmount('0.1'),'0.1');assert.equal(formatSalesforceAmount('NaN'),'未取得');
assert.ok(report(['0.1','0.2']).includes('0.3 円'));
assert.ok(report(['-0.1','0.2']).includes('0.1 円'));
assert.ok(!report(['1',null]).includes('対象期間の商談合計金額：'));
assert.ok(!report(['1','2'],{complete:false}).includes('対象期間の商談合計金額：'));
let metadata=canvasMetadataSuggestions('| 月 | 商談金額（円） |\n| --- | --- |\n| 1月 | 60,000 |','SalesforceでJ＆T環境の商談を2026年1〜3月で集計');
assert.deepEqual(metadata,{unit:'円',period:'2026-01-01〜2026-03-31',source:'Salesforce'});
assert.equal(canvasMetadataSuggestions('', '2026年4月1日〜9月30日の商談金額').period,'2026-04-01〜2026-09-30');
assert.equal(canvasMetadataSuggestions('', '2026年4月〜6月').period,'2026-04-01〜2026-06-30');
assert.equal(canvasMetadataSuggestions('', '2026年4月に変更\n2025年1〜3月').period,'2026-04-01〜2026-04-30');
assert.equal(canvasMetadataSuggestions('', '来月に変更\n2025年1〜3月').period,'');
for(const followup of ['月別の棒グラフにして','毎月の棒グラフにして','月ごとの表にして','年別で表示して','週別にして','同じ期間で月別にして','期間はそのままで月別にして']){
  assert.equal(canvasMetadataSuggestions('',`${followup}\n完了予定日が2026年1月1日〜3月31日、月別合計を表で`).period,'2026-01-01〜2026-03-31',followup);
}
assert.equal(canvasMetadataSuggestions('', '来月に変更して月別の棒グラフにして\n2026年1〜3月').period,'');
assert.equal(canvasMetadataSuggestions('', '2026年4〜6月の月別グラフに変更\n2026年1〜3月').period,'2026-04-01〜2026-06-30');
assert.equal(canvasMetadataSuggestions('', '2026年1月1日〜3月31日').period,'2026-01-01〜2026-03-31');
assert.equal(canvasMetadataSuggestions('', '2026年2月30日〜3月31日').period,'');
assert.equal(canvasMetadataSuggestions('', '2026年4〜3月').period,'');
assert.equal(canvasMetadataSuggestions('対象期間：2026-07-01〜2026-09-30','2026年1〜3月').period,'2026-07-01〜2026-09-30');
assert.equal(canvasMetadataSuggestions('単位：千円\n出典：社内集計','Salesforceで商談金額を検索').unit,'千円');
assert.equal(canvasMetadataSuggestions('単位：千円\n出典：社内集計','Salesforceで商談金額を検索').source,'社内集計');
assert.equal(canvasMetadataSuggestions('単位：円\n単位：千円','商談金額').unit,'');
const messages=[{role:'user',content:'Salesforceで2025年1〜3月の商談金額'},{role:'assistant',content:'古い回答'},{role:'user',content:'Salesforceで2026年1〜3月の商談金額'},{role:'assistant',content:'候補を選択'},{role:'user',content:'2番で'},{role:'assistant',content:'今回の回答'},{role:'user',content:'2027年4〜6月の別の依頼'}];
assert.equal(canvasMetadataSuggestions('',canvasChatContext(messages,'今回の回答')).period,'2026-01-01〜2026-03-31');
assert.equal(canvasMetadataSuggestions('',canvasChatContext(messages,'古い回答')).period,'2025-01-01〜2025-03-31');
assert.equal(canvasMetadataSuggestions('```\n対象期間：2020年1〜3月\n```','2026年1〜3月').period,'2026-01-01〜2026-03-31');
console.log('PASS Canvas report formatting: yen/commas, exact 1-billion threshold, consistent thousand-yen values, missing totals, chat-scoped period/unit/source candidates');
