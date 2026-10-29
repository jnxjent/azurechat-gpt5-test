const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const cache=new Map();
function load(name){
 const file=path.resolve(__dirname,'../features/skills/execution',name+'.ts');
 if(cache.has(file))return cache.get(file);
 const m={exports:{}};cache.set(file,m.exports);
 new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>load(id.replace('./','')),m,m.exports);
 return m.exports;
}
const {progressReportEvidence}=load('skill-progress-evidence');
const {boundSearchResult,SKILL_SEARCH_LIMITS}=load('skill-search-policy');
const {boundProgressResult,progressResultPages,progressRankingMarkdown,PROGRESS_INPUT_BYTES,PROGRESS_REPORT_BYTES,progressContextWithinBudget}=load('skill-progress-transport');
const {progressAmountSummary}=load('skill-progress-amount');
const rows=Array.from({length:28},(_,i)=>({
 Id:'006'+String(i).padStart(12,'0')+'AAA',Name:'【東京支店・2026年更新】産業廃棄物収集運搬・処分契約／混合廃棄物／年間契約 '+i,
 AccountName:'株式会社サンプル環境ソリューションズ 営業所・工場／事業所 '+i,OwnerName:'黄 太郎',
 StageName:'見積提示',Amount:10000+i,Probability:15,CloseDate:'2026-10-01',LastActivityDate:null,
 lightning_url:'https://example--fullsand.sandbox.lightning.force.com/lightning/r/Opportunity/006'+String(i).padStart(12,'0')+'AAA/view',
 Loss_Reason__c:null,IsClosed:false,IsWon:false,LastModifiedDate:'2026-10-28T10:00:00Z',
}));
function prepare(data,object='Opportunity') {return progressReportEvidence({source:'salesforce',status:'ok',returnedObject:object,data,totalCount:data.length,fetchedCount:data.length,modelVisibleCount:data.length},'2026-10-29');}
const prepared=prepare(rows),before=JSON.stringify(prepared);
assert.ok(boundSearchResult(prepared).data.length<28,'Reproduce loss using realistic Japanese names, links and evidence');
const result=boundProgressResult(prepared),pages=progressResultPages(result);
assert.equal(result.modelVisibleCount,28);assert.equal(result.data.length,28);assert.ok(pages.length>1);
assert.equal(result.amountSummary.valueSum,'280378');
assert.equal(JSON.stringify(prepared),before);
assert.deepEqual(pages.flatMap(p=>p.data),result.data,'All fields and records arrive once, in order');
assert.equal(new Set(pages.flatMap(p=>p.data.map(row=>row.Id))).size,28);
for(const p of pages){assert.ok(Buffer.byteLength(JSON.stringify(p))<=SKILL_SEARCH_LIMITS.resultBytes);assert.equal(p.modelVisibleCount,28);assert.equal(p.progressSummary.recordCount,28);assert.equal(p.truncated,undefined);}
assert.ok(pages.every(p=>p.amountSummary.valueSum==='280378'),'Each page carries the same once-computed total');
assert.ok(pages.reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0)<=PROGRESS_INPUT_BYTES);
const md=progressRankingMarkdown(result);
assert.ok(md.includes('取得28件、AI入力28件'));assert.ok(md.includes('20件掲載／分析対象28件'));
for(const row of result.data.slice(0,3)) assert.ok(md.includes(`${row.progressRank}. [${row.Name}]`),'Summary uses same ranks as table');
for(const row of result.data.slice(0,5)) assert.ok(md.includes(`| ${row.progressRank} | [${row.Name}]`),'Follow-ups use same rank and record');
assert.ok(!md.includes('\n\n| ---'),'Markdown tables remain contiguous');
const tasks=Array.from({length:75},(_,i)=>({Id:'00T'+String(i).padStart(12,'0'),object:'Task',IsClosed:i%2===0,Status:'任意状態',Subject:'長い活動件名'.repeat(8),ActivityDate:'2026-10-01',lightning_url:rows[0].lightning_url}));
const activity=boundProgressResult(prepare(tasks,'Activity'));
assert.equal(activity.modelVisibleCount,75);assert.equal(progressResultPages(activity).flatMap(p=>p.data).length,75);
assert.equal(activity.activitySummary.completedTasks,38);assert.equal(activity.activitySummary.overdueOpenTasks,37);
const many=boundProgressResult(prepare(Array.from({length:200},(_,i)=>({...rows[i%28],Id:'record-'+i}))));
if(many.status==='ok')assert.equal(progressResultPages(many).flatMap(p=>p.data).length,200);
else {assert.equal(many.status,'limit');assert.equal(many.modelVisibleCount,0);assert.deepEqual(many.data,[]);}
for(const data of [[{...rows[0],Name:'長'.repeat(20000)}],Array.from({length:200},(_,i)=>({...rows[0],Name:'案件'.repeat(300),Id:'record-'+i}))]){
 const limited=boundProgressResult(prepare(data));assert.equal(limited.status,'limit');assert.equal(limited.fetchedCount,data.length);assert.equal(limited.modelVisibleCount,0);assert.deepEqual(limited.data,[]);assert.equal(progressRankingMarkdown(limited),'');
}
const partial=boundProgressResult({...prepared,totalCount:50,truncated:true});
assert.equal(partial.truncated,true);assert.equal(partial.modelVisibleCount,28,'Upstream truncation is distinct from AI input completeness');
const hostile=boundProgressResult(prepare([{...rows[0],Name:'[会社](javascript:bad) | <script>',lightning_url:'javascript:bad'}]));
assert.ok(!progressRankingMarkdown(hostile).includes('](<javascript:'));
assert.equal(progressContextWithinBudget([{content:'x'.repeat(PROGRESS_REPORT_BYTES)}]),false);
assert.equal(progressContextWithinBudget([{content:'x'.repeat(100)}]),true);
const decimals=progressAmountSummary([{Amount:0.1},{Amount:0.2},{Amount:-0.1},{Amount:null},{Amount:'5'},{Amount:Infinity}]);
assert.equal(decimals.valueSum,'0.2');assert.equal(decimals.valuedRecords,3);assert.equal(decimals.missingRecords,1);assert.equal(decimals.invalidRecords,2);
assert.equal(progressAmountSummary([{Amount:1e21},{Amount:1e-7}]).valueSum,'1000000000000000000000.0000001');
assert.equal(progressAmountSummary([{Amount:null}]).valueSum,null,'All missing is not a zero total');
assert.equal(progressAmountSummary([{Amount:0}]).valueSum,'0');
console.log('PASS lossless multi-page progress input, realistic 28 records, 75 activities, explicit capacity failure and deterministic ranked sections');
