const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const fs = require('node:fs');
const moduleUnderTest = {exports:{}};
Function('exports','module',ts.transpileModule(fs.readFileSync('features/desknets-agent/desknets-agent-transport.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(moduleUnderTest.exports,moduleUnderTest);
const {deskNetsTransportMessage,fetchDeskNetsAgent}=moduleUnderTest.exports;
test('transport failures distinguish timeout and do not disclose raw error details',()=>{
  assert.match(deskNetsTransportMessage(new TypeError('fetch failed secret')),/VMとAPI/);
  assert.doesNotMatch(deskNetsTransportMessage(new Error('secret')),/secret/);
  const timeout=new Error('secret');timeout.name='TimeoutError';
  assert.match(deskNetsTransportMessage(timeout),/処理が開始済み/);
});
test('failed POST is sent once with a timeout, never automatically retried',async()=>{
  const previous=global.fetch;let calls=0;
  global.fetch=async(url,init)=>{calls++;assert.equal(init.method,'POST');assert.ok(init.signal instanceof AbortSignal);throw new TypeError('fetch failed');};
  try{await assert.rejects(()=>fetchDeskNetsAgent('https://agent.invalid',{method:'POST'}));assert.equal(calls,1);}finally{global.fetch=previous;}
});
