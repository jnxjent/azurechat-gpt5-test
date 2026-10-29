const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict'),path=require('node:path');
const m={exports:{}};
const amount={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../features/skills/execution/skill-progress-amount.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(amount,amount.exports);
new Function('require','module','exports',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../features/skills/execution/skill-progress-evidence.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(()=>amount.exports,m,m.exports);
const {progressEvidence}=m.exports;
const input={source:'salesforce',status:'ok',returnedObject:'Opportunity',totalCount:58,data:[
 {Id:'today',StageName:'作業段取り',CloseDate:'2026-10-28',LastActivityDate:'2026-10-27',Amount:99999},
 {Id:'overdue',StageName:'契約締結',CloseDate:'2026-10-26',LastActivityDate:'2026-09-28'},
 {Id:'oldest',StageName:'見積提示',CloseDate:'2026-10-02'},
 {Id:'won',StageName:'作業完了',CloseDate:'2020-01-01'},
]};
const before=JSON.stringify(input),result=progressEvidence(input,'2026-10-28');
assert.equal(JSON.stringify(input),before,'Proof-backed input rows remain unmodified');
assert.deepEqual(result.data.map(r=>r.Id),['oldest','overdue','today','won']);
assert.equal(result.data[0].progressEvidence.overdueDays,26);
assert.equal(result.data[1].progressEvidence.daysSinceLastActivity,30);
assert.equal(result.data[2].progressEvidence.overdueDays,0);
assert.equal(result.data[3].progressEvidence,undefined);
const activity=progressEvidence({source:'salesforce',status:'ok',returnedObject:'Activity',data:[{Id:'00T123',ActivityDate:'2026-02-30',Status:'Completed'},{Id:'00U123',ActivityDate:'2026-10-01'}]},'2026-10-28');
assert.equal(activity.data[0].progressEvidence.overdueDays,null);
assert.equal(activity.data[0].progressEvidence.taskCompletion,'unverified');
assert.equal(activity.data[1].progressEvidence,undefined,'An Event is not a pending Task');
assert.equal(progressEvidence(input,'bad'),input);
const missing=progressEvidence({source:'salesforce',status:'ok',returnedObject:'Opportunity',data:[
 {Id:'recent',StageName:'見積提示',CloseDate:'2026-11-01',LastActivityDate:'2026-10-27'},
 {Id:'missing-last',StageName:'見積提示',CloseDate:'2026-11-01',LastActivityDate:null},
 {Id:'missing-close',StageName:'見積提示',CloseDate:null,LastActivityDate:'2026-10-27'},
]},'2026-10-28');
assert.deepEqual(missing.data.map(r=>r.Id),['missing-last','missing-close','recent']);
assert.equal(missing.data[0].progressEvidence.lastActivityMissing,true);
assert.equal(missing.data[0].progressEvidence.daysSinceLastActivity,null,'Missing is not an invented elapsed duration');
assert.equal(missing.data[1].progressEvidence.closeDateMissing,true);
console.log('PASS progress calendar days, ranking, immutable records and Task/Event distinction');

const policy={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../features/skills/execution/skill-search-policy.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(policy,policy.exports);
const {progressReportEvidence}=m.exports;
const opportunities={source:'salesforce',status:'ok',returnedObject:'Opportunity',fetchedCount:28,modelVisibleCount:28,totalCount:28,data:Array.from({length:28},(_,i)=>({
 Id:'op-'+i,Name:'確認案件'+i,Account:{Id:'account',Name:'取引先'},OwnerName:'担当営業',StageName:'見積提示',Amount:i*100,
 CloseDate:'2026-10-01',LastActivityDate:'2026-09-01',Description:'長い商談説明'.repeat(300),lightning_url:'https://example.invalid/op-'+i,
}))};
const original=JSON.stringify(opportunities);
assert.ok(policy.exports.boundSearchResult(progressEvidence(opportunities,'2026-10-29')).data.length<28,'Reproduce rows lost under the existing byte budget');
const prepared=progressReportEvidence(opportunities,'2026-10-29');
const bounded=policy.exports.boundSearchResult(prepared);
assert.equal(JSON.stringify(opportunities),original);
assert.equal(bounded.data.length,28,'All 28 analytical records fit without raising the byte budget');
assert.equal(bounded.modelVisibleCount,28);
assert.equal(bounded.truncated,undefined);
assert.equal(bounded.data[0].Id,'op-27');
assert.deepEqual(bounded.data.map(r=>r.progressRank),Array.from({length:28},(_,i)=>i+1));
assert.equal(bounded.progressSummary.stageCounts['見積提示'],28);
assert.equal(bounded.progressSummary.complete,true);
assert.deepEqual(bounded.progressSummary.omittedFields,['Description']);
assert.equal(bounded.data[0].lightning_url,'https://example.invalid/op-27');
assert.equal(progressReportEvidence({...opportunities,truncated:true,totalCount:40},'2026-10-29').progressSummary.complete,false);
assert.equal(progressReportEvidence({...opportunities,totalCount:null},'2026-10-29').progressSummary.complete,false);
assert.equal(progressReportEvidence({...opportunities,excludedCount:1},'2026-10-29').progressSummary.complete,false);
const large={...prepared,data:prepared.data.map(row=>({...row,Name:'長い案件名'.repeat(1000)}))};
const limited=policy.exports.boundSearchResult(large);
assert.ok(limited.data.length<28);
assert.equal(limited.modelVisibleCount,limited.data.length);
assert.equal(limited.fetchedCount,28);
assert.equal(limited.progressSummary.recordCount,28,'Summary covers fetched rows before presentation truncation');
assert.equal(limited.truncated,true);
console.log('PASS 28-record projection, deterministic ranks, fetched summary and byte-limit disclosure');

const tasks={source:'salesforce',status:'ok',returnedObject:'Activity',totalCount:8,fetchedCount:8,modelVisibleCount:8,data:[
 {Id:'00T-open',object:'Task',IsClosed:false,Status:'Finished',ActivityDate:'2026-10-27'},
 {Id:'00T-done',object:'Task',IsClosed:true,Status:'Open',ActivityDate:'2026-10-01'},
 {Id:'00T-unknown',object:'Task',Status:'Completed',ActivityDate:'2026-10-01'},
 {Id:'00T-string',object:'Task',IsClosed:'false',ActivityDate:'2026-10-01'},
 {Id:'00T-invalid-date',object:'Task',IsClosed:false,ActivityDate:'2026-02-30'},
 {Id:'00T-today',object:'Task',IsClosed:false,ActivityDate:'2026-10-29'},
 {Id:'00T-missing-date',object:'Task',IsClosed:false,ActivityDate:null},
 {Id:'00U-event',object:'Event',IsClosed:false,ActivityDate:'2026-10-01'},
]};
const taskOriginal=JSON.stringify(tasks);
const activityResult=progressReportEvidence(tasks,'2026-10-29');
assert.equal(JSON.stringify(tasks),taskOriginal);
assert.deepEqual(activityResult.activitySummary,{scope:'fetched_records',recordCount:8,complete:true,completedTasks:1,openTasks:4,unverifiedTasks:2,overdueOpenTasks:1,events:1,unknownRecords:0});
assert.equal(activityResult.data[0].progressEvidence.overdueDays,2);
assert.equal(activityResult.data[1].progressEvidence.overdueDays,null,'Completed tasks do not remain overdue');
assert.equal(activityResult.data[2].progressEvidence.taskCompletion,'unverified','Status labels never replace IsClosed');
assert.equal(activityResult.data[3].progressEvidence.taskCompletion,'unverified','Strings are not verified booleans');
assert.equal(activityResult.data[4].progressEvidence.overdueDays,null);
assert.equal(activityResult.data[5].progressEvidence.overdueDays,0);
assert.equal(activityResult.data[6].progressEvidence.dueDateMissing,true);
assert.equal(activityResult.data[7].progressEvidence,undefined);
assert.equal(progressReportEvidence({...tasks,totalCount:12,truncated:true},'2026-10-29').activitySummary.complete,false);
const activityLimited=policy.exports.boundSearchResult({...activityResult,data:activityResult.data.map(row=>({...row,Description:'長文'.repeat(5000)}))});
assert.ok(activityLimited.modelVisibleCount<8);
assert.equal(activityLimited.activitySummary.openTasks,4,'Counts survive input truncation');
assert.equal(progressReportEvidence({...tasks,returnedObject:'Task',data:[tasks.data[0]],totalCount:1},'2026-10-29').activitySummary.openTasks,1);
console.log('PASS authoritative Task completion, date boundaries, Event separation and pre-truncation counts');
assert.equal(progressReportEvidence({...tasks,status:'empty',data:[],totalCount:0},'2026-10-29').activitySummary.complete,true);
assert.equal(progressReportEvidence({...opportunities,status:'empty',data:[],totalCount:0},'2026-10-29').progressSummary.recordCount,0);
const lost=progressReportEvidence({...opportunities,data:[{Id:'lost',StageName:'失注',Loss_Reason__c:'顧客都合',NextStep:'再確認'}],totalCount:1},'2026-10-29');
assert.equal(lost.data[0].Loss_Reason__c,'顧客都合');
assert.equal(lost.data[0].progressRank,undefined,'Do not assign open-opportunity priorities to lost records');
assert.equal(progressReportEvidence({...tasks,status:'error'},'2026-10-29').activitySummary,undefined,'Errors are not empty successful reads');
require('./test-skill-progress-transport.cjs');
require('./test-skill-analysis.cjs');
