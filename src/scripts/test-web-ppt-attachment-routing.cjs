const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
let stored, docs = [], captured, loads = 0;
const ok = response => ({ status: 'OK', response });
const services = {
  prepareSkillsForChat: async () => ({selected:[]}), shouldRunSkillSearch: () => false, skillAuthoringInstructions: () => undefined, skillReferenceLabel: () => "", formatSkillContext: () => "",
  getCurrentUser: async () => ({ name: 'Local test', email: 'local@example.test' }),
  EnsureChatThreadOperation: async () => ok({ id: 'thread-local', extension: [], personaMessage: '' }),
  listUserMemories: async () => [], handleMemoryChatCommand: async () => null,
  prepareAutomaticMemory: async () => '本人用メモリー：回答は簡潔にする。',
  resolveMemoryRelevance: async () => ({ selected: [] }),
  selectMemories: () => [], formatMemoryContext: () => '',
  memoryReferenceLabel: () => '',
  isSalesforceAllowedEmail: () => false, resolveSalesforceRoute: () => ({ route: 'normal' }),
  isDeskNetsAgentEnabled: () => false,
  isSharePointImageRequest: () => false, resolveRequiredImageToolName: () => undefined,
  LoadLatestImageAttachment: async () => { loads++; return stored; },
  LoadPendingPptxEdit: async () => null,
  FindTopChatMessagesForCurrentUser: async () => ok([]), mapOpenAIChatMessages: x => x,
  FindAllChatDocuments: async () => ok(docs),
  FindAllExtensionForCurrentUser: async () => ok([]),
  GetDefaultExtensions: async () => ok([{ function: { name: 'convert_doc_to_pptx' } }]),
  GetDynamicExtensions: async () => ok([]), CreateChatMessage: async () => ok({}),
  UploadImageToStore: async () => ok({}),
  GenerateSasUrl: async (container, name) => ok(`https://local.test/${container}/${name}`),
  ChatApiExtensions: async x => { captured = x; return {}; },
  OpenAIStream: () => new ReadableStream({ start(c) { c.close(); } }),
};
function load(relative) {
  const filename = path.resolve(relative);
  const mod = new Module(filename); mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name === 'server-only') return {};
    if (name === './image/image-intent') return load('features/chat-page/chat-services/chat-api/image/image-intent.ts');
    if (name === '@/features/pptx/output-intent') return load('features/pptx/output-intent.ts');
    if (name === '@/features/pptx/palette') return { resolvePptxPaletteInstruction: () => null };
    if (name.startsWith('@/') || name.startsWith('../') || name.startsWith('./')) return services;
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
  return mod.exports;
}
async function main() {
  const { ChatAPIEntry } = load('features/chat-page/chat-services/chat-api/chat-api.ts');
  const run = async (message, image = '') => {
    captured = undefined; loads = 0;
    await ChatAPIEntry({ id: 'thread-local', message, multimodalImage: image }, new AbortController().signal);
    assert(captured, 'actual Web entry must reach extension routing');
    assert(captured.chatThread.personaMessage.includes('本人用メモリー：回答は簡潔にする。'), 'automatic memory reaches the Web answer model');
  };
  stored = { contentType: 'image/png', buffer: Buffer.from('image'), fileName: 'poster.png' };
  for (const message of ['添付ファイルをPPTにして', 'この画像を編集可能なPPTに変換して', '添付をPowerPointに変換して']) {
    await run(message);
    assert.equal(loads, 1);
    assert.equal(captured.requiredToolName, 'convert_doc_to_pptx');
    assert(captured.history.some(x => String(x.content).includes('file_url: https://local.test/images/')));
  }
  await run('添付ファイルをPPTにして', 'data:image/png;base64,aW1hZ2U=');
  assert.equal(loads, 0);
  assert.equal(captured.requiredToolName, 'convert_doc_to_pptx');
  docs = [{ name: 'source.pdf' }];
  await run('添付ファイルをPPTに変換して');
  assert(captured.history.some(x => String(x.content).includes('/dl-link/')));
  assert(!captured.history.some(x => String(x.content).includes('/images/')));
  docs = []; stored = null;
  docs = [{ name: 'poster.png' }];
  await run('添付ファイルをPPTにして');
  assert.equal(captured.requiredToolName, 'convert_doc_to_pptx');
  assert(captured.history.some(x => String(x.content).includes('/dl-link/thread-local/poster.png')));
  docs = [];
  await run('添付ファイルをPPTにして');
  assert.equal(captured.requiredToolName, undefined, 'no source must not fabricate conversion');
  await run('添付を参考に営業用PPTを作成して');
  assert.equal(captured.requiredToolName, 'create_pptx');
  await run('今出した廃棄物処理車の荷台の「Midac」という文字を添付Logoに差し替えて絵を出して', 'data:image/png;base64,aW1hZ2U=');
  assert.equal(captured.requiredToolName, 'edit_existing_image');
  await run('今のPPTのロゴを添付Logoに差し替えて', 'data:image/png;base64,aW1hZ2U=');
  assert.equal(captured.requiredToolName, 'edit_pptx');
  services.prepareSkillsForChat = async () => ({selected:[{title:'取引先情報',version:1}]});
  services.shouldRunSkillSearch = count => count > 0;
  let skillExecution;
  services.runSkillSearch = async props => {skillExecution=props;return {directContent:'固定候補表',citationResults:['{"integration":"skill_search_account_candidates","records":[]}']};};
  const saved=[];services.CreateChatMessage = async props => {saved.push(props);return ok({});};
  captured=undefined;
  const selected=await ChatAPIEntry({id:'thread-local',message:'Skill「取引先情報」で調べて',multimodalImage:''},new AbortController().signal);
  assert.ok(skillExecution);assert.equal(captured,undefined,'explicit Skill takes its own route');
  assert.ok((await selected.text()).includes('固定候補表'));
  assert.equal(saved.at(-1).role,'assistant');assert.equal(saved.at(-2).role,'tool');
  console.log('Web PPT attachment routing passed (actual ChatAPIEntry, storage/model doubles).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
