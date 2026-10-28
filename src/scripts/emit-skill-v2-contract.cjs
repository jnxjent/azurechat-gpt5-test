// Local cross-repository contract fixture. No settings, network or user data.
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../features/skills/execution/skill-read-v2.ts'),'utf8');
const unit={exports:{}};
new Function('exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(unit.exports);
process.env.SF_SKILL_READ_V2_ENABLED='true';
const body=unit.exports.buildTypedSkillReadV2('黄さんの失注商談一覧','黄さんの今期の失注商談をまとめて',
    {owner:'黄',period:'今期',target:'opportunities'},'opportunities');
if(!body)throw Error('Missing typed contract');
process.stdout.write(JSON.stringify(body));
