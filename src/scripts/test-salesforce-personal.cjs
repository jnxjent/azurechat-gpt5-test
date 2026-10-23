const fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const file = path.resolve(__dirname, '../features/common/services/salesforce-personal.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const loaded = { exports: {} };
const accessModule = { exports: {} };
new Function('module', 'exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../features/common/services/salesforce-access.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(accessModule, accessModule.exports);
const access = accessModule.exports;
const principal = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
let user = { email: 'a@example.com', salesforcePrincipal: principal };
new Function('require', 'module', 'exports', code)(id => id === './salesforce-access' ? access : id === 'server-only' ? {} : id === '@/features/auth-page/helpers' ? { getCurrentUser: async () => user } : require(id), loaded, loaded.exports);
async function main() {
  const profileModule = { exports: {} };
  const profileCode = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../features/auth-page/salesforce-principal.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('module', 'exports', profileCode)(profileModule, profileModule.exports);
  const derive = profileModule.exports.salesforcePrincipalFromProfile;
  const [tenant, objectId] = principal.split(':');
  assert.equal(derive('azure-ad', { tid: tenant, oid: objectId }, tenant), principal);
  assert.equal(derive('credentials', { tid: tenant, oid: objectId }, tenant), undefined);
  assert.equal(derive('azure-ad', { tid: tenant, oid: objectId }, objectId), undefined);
  assert.equal(derive('azure-ad', { email: 'a@example.com' }, tenant), undefined);
  const original = { mode: process.env.SF_PERSONAL_MODE, key: process.env.SF_PERSONAL_SIGNING_KEY, policy: process.env.SF_PERSONAL_SNAPSHOT_POLICY };
  try {
    const api = loaded.exports, url = new URL('https://gateway.example.com/api/sf/query_nl?q=%E5%8F%96%E5%BC%95%E5%85%88');
    process.env.SF_PERSONAL_MODE = 'false';
    assert.deepEqual(await api.salesforcePersonalHeaders(url, user.email, 'thread'), {});
    process.env.SF_PERSONAL_USERS_JSON=JSON.stringify([{principal,email:user.email}]);
    process.env.SF_PERSONAL_MODE = 'true'; process.env.SF_PERSONAL_SIGNING_KEY = 'x'.repeat(40);
    process.env.SF_PERSONAL_SNAPSHOT_POLICY = '';
    await assert.rejects(() => api.salesforcePersonalHeaders(url, user.email, 'thread'));
    process.env.SF_PERSONAL_SNAPSHOT_POLICY = 'strict';
    const headers = await api.salesforcePersonalHeaders(url, user.email, 'thread');
    const claim = JSON.parse(Buffer.from(headers['X-AC-Identity'], 'base64url'));
    assert.equal(claim.principal, principal); assert.equal(claim.target, url.pathname + url.search);
    assert.equal(claim.body, crypto.createHash('sha256').update('').digest('hex'));
    assert.equal(headers['X-AC-Signature'], crypto.createHmac('sha256', 'x'.repeat(40)).update(headers['X-AC-Identity']).digest('hex'));
    // Exercise the Python verifier using the actual TypeScript signature and URL encoding.
    const gateway = process.env.SF_GATEWAY_SOURCE || path.resolve(__dirname, '../../../sf-gateway');
    if (fs.existsSync(path.join(gateway, 'core/sf_personal.py'))) {
      const script = `
import sys,json,os,tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
from flask import Flask,jsonify
from core import sf_personal
data=json.load(sys.stdin)
with tempfile.TemporaryDirectory() as directory:
 os.environ.update(SF_PERSONAL_MODE='true',SF_PERSONAL_SNAPSHOT_POLICY='strict',SF_PERSONAL_SIGNING_KEY='x'*40,SF_PERSONAL_REPLAY_DB_PATH=str(Path(directory)/'replay.db'))
 app=Flask(__name__)
 sf_personal.install(app)
 @app.get('/api/sf/query_nl')
 def query(): return jsonify(ok=True)
 binding={'enabled':True,'org_id':'00D000000000001AAA','user_id':'005000000000001AAA','generation':'1'}
 with patch.object(sf_personal,'mapping_for',return_value=binding),patch.object(sf_personal,'mint',return_value=('test-only','https://test.sandbox.my.salesforce.com')):
  result=app.test_client().get(data['target'],headers=data['headers'])
  assert result.status_code==200, result.json
  print(json.dumps({'mode':result.headers['X-SF-Connection-Mode'],'principal':result.headers['X-AC-Principal']}))
`;
      const output = require('node:child_process').execFileSync('python', ['-c', script, gateway], {
        input: JSON.stringify({ target: claim.target, headers: { ...headers, 'X-User-Email': user.email, 'X-Chat-Thread-Id': 'thread' } }), encoding: 'utf8', timeout: 30000,
      });
      assert.deepEqual(JSON.parse(output), { mode: 'personal-jwt', principal });
      console.log('PASS TypeScript -> Python/Flask signed identity integration (no Salesforce network calls)');
    }
    assert.notEqual((await api.salesforcePersonalHeaders(url, user.email, 'thread'))['X-AC-Identity'], headers['X-AC-Identity']);
    assert.throws(() => api.assertPersonalSalesforceResponse(new Response('{}'), headers), /Gateway/);
    api.assertPersonalSalesforceResponse(new Response('{}', { headers: { 'X-SF-Connection-Mode': 'personal-jwt', 'X-AC-Principal': principal, 'X-SF-User-Id': '005000000000001AAA', 'X-SF-Org-Id': '00D000000000001AAA' } }), headers);
    assert.throws(() => api.assertPersonalSalesforceResponse(new Response('{}', { headers: { 'X-SF-Connection-Mode': 'personal-jwt', 'X-AC-Principal': 'another-person' } }), headers));
    await assert.rejects(() => api.salesforcePersonalHeaders(url, 'other@example.com', 'thread'));
    await assert.rejects(() => api.salesforcePersonalHeaders(new URL('http://external.example.com'), user.email, 'thread'));
    user = { email: 'a@example.com' };
    await assert.rejects(() => api.salesforcePersonalHeaders(url, user.email, 'thread'));
    function loadGuard(relative) {
      const mod = { exports: {} };
      const script = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
      new Function('require', 'module', 'exports', script)(id => id === '@/features/common/services/salesforce-personal' ? api : id === 'server-only' || id.startsWith('@/') || id.startsWith('./') ? {} : require(id), mod, mod.exports);
      return mod.exports;
    }
    const teams = loadGuard('features/teams/teams-salesforce-service.ts');
    // Teams is enabled, but an unverified actor must still fail closed.
    assert.match(await teams.queryTeamsSalesforce({ message: 'count', userEmail: user.email, conversationId: 'same', activityId: 'same' }), /本人対応を確認できません/);
    const skills = loadGuard('features/skills/execution/skill-search-tools.ts');
    const tool = skills.createSkillSearchTools({ email: user.email, threadId: 'same', userMessage: 'count', signal: new AbortController().signal });
    assert.equal((await tool.execute('salesforce', 'count')).reason, 'personal_route_not_enabled');
    // Every SF-enabled Web user selects the personal path, even before mapping
    // or OAuth enrollment exists. Missing identity must never select shared SF.
    process.env.SF_PERSONAL_SCOPE = 'whitelist';
    process.env.SF_WHITELIST_EMAILS = 'a@example.com,b@example.com';
    process.env.SF_PERSONAL_USERS_JSON = '[]';
    user = { email: 'b@example.com', salesforcePrincipal: principal };
    assert.equal(await api.isPersonalSalesforceUser(), true);
    assert.equal(api.personalSalesforceForEmail(user.email), true);
    assert.ok((await api.salesforcePersonalHeaders(url, user.email, 'thread'))['X-AC-Identity']);
    user = { email: 'b@example.com' };
    assert.equal(await api.isPersonalSalesforceUser(), true);
    await assert.rejects(() => api.salesforcePersonalHeaders(url, user.email, 'thread'));
    user = { email: 'outsider@example.com', salesforcePrincipal: principal };
    assert.equal(await api.isPersonalSalesforceUser(), false);
    assert.equal(api.personalSalesforceForEmail(user.email), false);
    delete process.env.SF_PERSONAL_SCOPE;
    delete process.env.SF_WHITELIST_EMAILS;
    console.log('PASS personal Salesforce: session identity, request binding, fresh nonce, TLS, and rejection of shared Gateway responses');
  } finally {
    for (const [key, value] of [['SF_PERSONAL_MODE', original.mode], ['SF_PERSONAL_SIGNING_KEY', original.key], ['SF_PERSONAL_SNAPSHOT_POLICY', original.policy]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
