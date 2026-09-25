const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const ts = require("typescript");

const source = readFileSync(join(__dirname, "../features/desknets-agent/desknets-agent-intent.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const loaded = { exports: {} };
new Function("module", "exports", compiled)(loaded, loaded.exports);
const { shouldRouteToDeskNetsAgent } = loaded.exports;

for (const message of [
  "では、１で。WEB会議も設定して。",
  "では上記１で。WEB会議も設定して",
  "候補2でTeams会議を作成して",
]) {
  assert.equal(shouldRouteToDeskNetsAgent(message, []), true, message);
}
for (const message of ["WEB会議の議事録を要約して", "候補１の説明をして"]) {
  assert.equal(shouldRouteToDeskNetsAgent(message, []), false, message);
}
console.log("DeskNet's routing checks passed");
