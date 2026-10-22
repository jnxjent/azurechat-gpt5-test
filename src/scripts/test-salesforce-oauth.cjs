const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const principal = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
let user = { email: 'a@example.com', salesforcePrincipal: principal }, requests = 0;
function load(relative, stubs) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  new Function('require', 'module', 'exports', code)(id => stubs[id] ?? require(id), mod, mod.exports);
  return mod.exports;
}
async function main() {
  Object.assign(process.env, { SF_PERSONAL_MODE: 'true', SF_PERSONAL_AUTH_METHOD: 'oauth', SF_PERSONAL_SNAPSHOT_POLICY: 'strict', SF_PERSONAL_SIGNING_KEY: 'x'.repeat(40), SF_PERSONAL_GATEWAY_BASE_URL: 'https://gateway.example.com', SF_GATEWAY_BASE_URL: 'https://shared.example.com', SF_PERSONAL_AUTH_BASE: 'https://test.salesforce.com', SF_PERSONAL_USERS_JSON: JSON.stringify([{ principal, email: user.email }]) });
  const helpers = { userSession: async () => user, getCurrentUser: async () => user };
  const personal = load('features/common/services/salesforce-personal.ts', { 'server-only': {}, '@/features/auth-page/helpers': helpers });
  const route = load('app/(authenticated)/api/salesforce/connection/start/route.ts', { '@/features/auth-page/helpers': helpers, '@/features/common/services/salesforce-access': { isSalesforceAllowedEmail: () => true }, '@/features/common/services/salesforce-personal': personal });
  let target = 'https://test.salesforce.com/services/oauth2/authorize?state=test';
  global.fetch = async (url, options) => {
    requests++;
    assert.equal(url.pathname, '/api/sf/oauth/start');
    const claim = JSON.parse(Buffer.from(options.headers['X-AC-Identity'], 'base64url'));
    assert.equal(claim.method, 'POST'); assert.equal(claim.principal, principal);
    return Response.json({ authorization_url: target });
  };
  const request = origin => new Request('https://ac.example.com/api/salesforce/connection/start', { method: 'POST', headers: { origin } });
  assert.equal((await route.POST(request('https://other.example.com'))).status, 403);
  assert.equal(requests, 0);
  assert.equal((await route.POST(request('https://ac.example.com'))).status, 303);
  target = 'https://evil.example.com/services/oauth2/authorize';
  assert.equal((await route.POST(request('https://ac.example.com'))).status, 503);
  user = { email: 'a@example.com' };
  const count = requests;
  assert.equal((await route.POST(request('https://ac.example.com'))).status, 503);
  assert.equal(requests, count);
  user = null;
  assert.equal((await route.POST(request('https://ac.example.com'))).status, 401);
  const responseHeaders = { 'X-SF-Connection-Mode': 'personal-oauth', 'X-AC-Principal': principal, 'X-SF-User-Id': '005000000000001AAA', 'X-SF-Org-Id': '00D000000000001AAA' };
  const signed = personal.signSalesforceRequest({ principal, email: 'a@example.com', thread: '', url: new URL('https://gateway.example.com/api/sf/connection') }, 'x'.repeat(40));
  personal.assertPersonalSalesforceResponse(new Response('{}', { headers: responseHeaders }), signed);
  assert.throws(() => personal.assertPersonalSalesforceResponse(new Response('{}', { headers: { ...responseHeaders, 'X-SF-Connection-Mode': 'personal-jwt' } }), signed));
  console.log('Salesforce OAuth Web entry, signed identity, origin, redirect and mode checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
