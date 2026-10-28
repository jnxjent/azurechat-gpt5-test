const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../lib/fiscal-period.ts'),'utf8');
const unit={exports:{}};
new Function('exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(unit.exports);
const cases=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/skill-v2-fiscal-period-cases.json'),'utf8'));
for(const c of cases)assert.deepEqual(unit.exports.resolveFiscalPeriod(c.expression,new Date(c.now)),{fiscalStart:c.start,fiscalEnd:c.end},c.expression+' '+c.now);
console.log('PASS shared Gateway/AzureChat fiscal dates, exclusive ends and JST boundary');
