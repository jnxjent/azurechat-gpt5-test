const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const principal = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
let user = { email: 'a@example.com', salesforcePrincipal: principal }, calls = 0, mismatch = false;
function load(relative, stubs) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  new Function('require', 'module', 'exports', code)(id => stubs[id] ?? require(id), mod, mod.exports);
  return mod.exports;
}
async function main() {
  Object.assign(process.env, { NEXTAUTH_URL: 'https://ac.example.com', SF_PERSONAL_MODE: 'false', SF_PERSONAL_USERS_JSON: '[]', SF_PERSONAL_TEST_SEARCH_USERS_JSON: JSON.stringify([{ principal, email: user.email }]), SF_PERSONAL_AUTH_METHOD: 'oauth', SF_PERSONAL_SNAPSHOT_POLICY: 'strict', SF_PERSONAL_SIGNING_KEY: 'x'.repeat(40), SF_PERSONAL_GATEWAY_BASE_URL: 'https://gateway.example.com', SF_GATEWAY_BASE_URL: 'https://shared.example.com' });
  const helpers = { userSession: async () => user, getCurrentUser: async () => user };
  const personal = load('features/common/services/salesforce-personal.ts', { 'server-only': {}, './salesforce-access': load('features/common/services/salesforce-access.ts', {}), '@/features/auth-page/helpers': helpers });
  const route = load('app/(authenticated)/api/salesforce/test-search/route.ts', { '@/features/auth-page/helpers': helpers, '@/features/common/services/salesforce-access': { isSalesforceAllowedEmail: () => true }, '@/features/common/services/salesforce-personal': personal, '@/features/common/services/salesforce-read-result': load('features/common/services/salesforce-read-result.ts', {}) });
  const threads = [];
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://gateway.example.com');
    assert.equal(url.pathname, '/api/sf/query_nl');
    const claim = JSON.parse(Buffer.from(options.headers['X-AC-Identity'], 'base64url'));
    assert.equal(claim.principal, principal); assert.equal(claim.method, 'GET');
    assert.equal(claim.thread, options.headers['X-Chat-Thread-Id']); threads.push(claim.thread);
    return Response.json({ ok: true, total_count: null, soql: 'must-not-return', snapshot_proof: 'must-not-return', items: [{ Name: 'Test', _instruction: 'must-not-return', attributes: {}, nested: { secret: 'must-not-return' } }] }, { headers: { 'X-SF-Connection-Mode': 'personal-oauth', 'X-AC-Principal': mismatch ? 'wrong' : principal, 'X-SF-User-Id': '005000000000001AAA', 'X-SF-Org-Id': '00D000000000001AAA' } });
  };
  const request = (q = '私の取引先', origin = 'https://ac.example.com') => new Request('http://localhost:3000/api/salesforce/test-search', { method: 'POST', headers: { origin }, body: JSON.stringify({ q, thread: 'untrusted-input' }) });
  assert.equal((await route.POST(request('x', 'https://evil.example.com'))).status, 403); assert.equal(calls, 0);
  assert.equal((await route.POST(request(''))).status, 400); assert.equal(calls, 0);
  let response = await route.POST(request()); assert.equal(response.status, 200);
  const data = await response.json(); assert.deepEqual(data.items, [{ Name: 'Test' }]); assert.equal(data.total, null);
  assert.equal(data.soql, undefined); assert.equal(data.snapshot_proof, undefined);
  await route.POST(request()); assert.notEqual(threads[0], threads[1]);
  assert.equal(await personal.isPersonalSalesforceUser(), false);
  assert.deepEqual(await personal.salesforcePersonalHeaders(new URL('https://shared.example.com/api/sf/query_nl'), user.email, 'old-thread'), {});
  await assert.rejects(() => personal.salesforcePilotSearchHeaders(new URL('https://gateway.example.com/api/sf/write'), user.email, 'x'));
  const before = calls; user = { email: 'other@example.com', salesforcePrincipal: principal };
  assert.equal((await route.POST(request())).status, 503); assert.equal(calls, before);
  user = { email: 'a@example.com' }; assert.equal((await route.POST(request())).status, 503); assert.equal(calls, before);
  user = { email: 'a@example.com', salesforcePrincipal: principal }; mismatch = true;
  assert.equal((await route.POST(request())).status, 503);
  user = null; assert.equal((await route.POST(request())).status, 401);
  console.log('PASS isolated personal pilot search: verified principal, fresh independent searches, no shared fallback, no history imports/writes, no internal metadata returned');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
