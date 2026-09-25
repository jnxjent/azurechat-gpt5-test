const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = readFileSync("features/desknets-agent/credential-request-origin.ts", "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
Function("exports", "module", javascript)(loaded.exports, loaded);
const { isAllowedCredentialOrigin } = loaded.exports;

test("allows the public TestSite origin behind an internal Azure proxy", () => {
  const publicUrl = "https://azurechat-gpt5-test.azurewebsites.net";
  const internalOrigin = "http://127.0.0.1:3000";
  assert.equal(isAllowedCredentialOrigin(publicUrl, internalOrigin, publicUrl), true);
  assert.equal(isAllowedCredentialOrigin("https://other.example", internalOrigin, publicUrl), false);
  assert.equal(isAllowedCredentialOrigin(null, internalOrigin, publicUrl), false);
});

test("uses the request origin for local development when no public URL is set", () => {
  assert.equal(isAllowedCredentialOrigin("http://localhost:3000", "http://localhost:3000", undefined), true);
  assert.equal(isAllowedCredentialOrigin("http://otherhost:3000", "http://localhost:3000", undefined), false);
});
