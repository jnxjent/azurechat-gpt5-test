const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict'),path=require('node:path');
const m={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../features/skills/execution/skill-progress-evidence.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(m,m.exports);
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
