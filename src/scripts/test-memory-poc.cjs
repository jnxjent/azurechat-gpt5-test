const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

let currentUser = "user-a";
let history = [];
const messages = [];
const documents = new Map();
let failBatch = false;
let raceMemo = false;
let batchCalls = 0;
let etag = 0;
const key = (user, id) => `${user}/${id}`;
const store = (body) => documents.set(key(body.userId, body.id), { ...body, _etag: String(++etag) });
const container = {
  items: {
    query(spec, options) {
      const params = Object.fromEntries(spec.parameters.map((p) => [p.name, p.value]));
      assert.equal(options.partitionKey, currentUser);
      return { async fetchAll() {
        return { resources: [...documents.values()].filter((item) =>
          item.userId === params["@userId"] && item.type === params["@type"] &&
          (!params["@id"] || item.id === params["@id"]) &&
          (!spec.query.includes("c.isDeleted = false") || !item.isDeleted)).map((item) => ({ ...item })) };
      } };
    },
    async create(body) {
      assert.equal(body.userId, currentUser);
      store(body);
    },
    async batch(operations, partition) {
      batchCalls++;
      assert.equal(partition, currentUser);
      operations.forEach((op) => assert.equal(op.resourceBody.userId, partition));
      if (raceMemo) {
        raceMemo = false;
        const memo = operations.find((op) => op.resourceBody.id === "memory-learnedlesson-common-md");
        if (memo) store(memo.resourceBody);
        return { code: 409, result: operations.map(() => ({ statusCode: 409 })) };
      }
      if (failBatch) return { code: 424, result: operations.map(() => ({ statusCode: 424 })) };
      for (const op of operations) {
        const old = documents.get(key(partition, op.resourceBody.id));
        if (op.operationType === "Create" && old) return { code: 409, result: [{ statusCode: 409 }] };
        if (op.ifMatch && old?._etag !== op.ifMatch) return { code: 412, result: [{ statusCode: 412 }] };
      }
      operations.forEach((op) => store(op.resourceBody));
      return { code: 200, result: operations.map(() => ({ statusCode: 201 })) };
    },
  },
  item(id, user) {
    return { async replace(body, options) {
      assert.equal(user, currentUser);
      const old = documents.get(key(user, id));
      assert.ok(old);
      assert.equal(options.accessCondition.type, "IfMatch");
      assert.equal(options.accessCondition.condition, old._etag);
      store(body);
    } };
  },
};
const stubs = {
  "server-only": {},
  "@/features/auth-page/helpers": { async userHashedId() { if (!currentUser) throw new Error("User not found"); return currentUser; } },
  "@/features/common/services/cosmos": { HistoryContainer: () => container },
  "@/features/common/services/openai": { OpenAIInstance() { throw new Error("OpenAI should not be called without configuration"); } },
  "@/features/theme/theme-config": { AI_NAME: "AI" },
  "@/features/chat-page/chat-services/chat-message-service": {
    async CreateChatMessage(item) { messages.push(item); return { status: "OK", response: item }; },
    async FindTopChatMessagesForCurrentUser() { return { status: "OK", response: history }; },
  },
};
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name).exports;
  const source = fs.readFileSync(path.join(__dirname, "../features/memory", `${name}.ts`), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  cache.set(name, module);
  new Function("require", "module", "exports", js)(
    (id) => Object.hasOwn(stubs, id) ? stubs[id] : id.startsWith("./") ? load(id.slice(2)) : require(id),
    module, module.exports
  );
  return module.exports;
}

const rules = load("memory-rules");
const { profileFacilityPreference } = load("memory-facility");
const { parseMemoryChatCommand: parse, answerMemoryCommand } = load("memory-chat");
const { buildLearnedLesson, LESSON_MEMO_CONTENT } = load("learned-lesson");
const service = load("memory-service");
const intelligence = load("memory-intelligence");
const { handleMemoryChatCommand: handle } = load("memory-chat-handler");
const memo = (title, mode, kind) => ({
  id: title, title, content: `# ${title}\n手順`, mode, kind, triggers: [],
  enabled: true, version: 1, updatedAt: "2026-10-02T00:00:00Z",
});

async function main() {
  const profile = { ...memo("プロフィール", "required", "memo"), memoryClass: "profile", content: "経営企画部\n優先会議室：アクトミーティングルームC", profileSummary: "経営企画部" };
  assert.equal(profileFacilityPreference([profile]), "アクトミーティングルームC");
  assert.equal(profileFacilityPreference([{ ...profile, content: "優先会議室：品川" }]), "品川");
  assert.equal(profileFacilityPreference([{ ...profile, enabled: false }]), undefined);
  assert.equal(profileFacilityPreference([{ ...profile, memoryClass: "reference" }]), undefined);
  assert.equal(profileFacilityPreference([profile, { ...profile, content: "優先会議室：有玉" }]), undefined);
  const conversionPrompt = "添付画像をできるだけ忠実にPPTにして出力してください。";
  const unrelatedDeployMemo = { ...memo("deploy", "manual"), content: "添付画像のPPTを出力してください。TestSite確認済みコミットをmainへcherry-pickするデプロイ手順。" };
  const envKeys = ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_DEPLOYMENT_NAME", "AZURE_OPENAI_ENDPOINT"];
  const originalEnv = envKeys.map(key => process.env[key]);
  const originalOpenAI = stubs["@/features/common/services/openai"].OpenAIInstance;
  try {
    envKeys.forEach(key => process.env[key] = "test-config");
    stubs["@/features/common/services/openai"].OpenAIInstance = () => ({chat:{completions:{create:async request => {
      assert.equal(request.temperature, undefined);
      return {choices:[{message:{content: JSON.stringify({decisions:[{id:"deploy",relevance:"low"}]})}}]};
    }}}});
    assert.deepEqual(await intelligence.resolveMemoryRelevance([unrelatedDeployMemo], conversionPrompt), {selected:[]});
    stubs["@/features/common/services/openai"].OpenAIInstance = () => { throw new Error("simulated model outage"); };
    assert.deepEqual(await intelligence.resolveMemoryRelevance([unrelatedDeployMemo], conversionPrompt), {selected:[]});
    assert.deepEqual((await intelligence.resolveMemoryRelevance([unrelatedDeployMemo], "deployメモを参照してください")).selected.map(m=>m.id), ["deploy"]);
  } finally {
    stubs["@/features/common/services/openai"].OpenAIInstance = originalOpenAI;
    envKeys.forEach((key,i) => originalEnv[i] === undefined ? delete process.env[key] : process.env[key] = originalEnv[i]);
  }
  const preparedProfile = await intelligence.prepareMemoryClassification(
    "プロフィール", "所属は経営企画部です。\nパスワードは保存対象外です。", "manual");
  assert.equal(preparedProfile.mode, "required");
  assert.equal(preparedProfile.memoryClass, "profile");
  assert.match(preparedProfile.profileSummary, /経営企画部/);
  assert.doesNotMatch(preparedProfile.profileSummary, /パスワード/);
  const preparedProcedure = await intelligence.prepareMemoryClassification(
    "デプロイ手順", "TestSiteへWorkflowで配置する。", "required");
  assert.equal(preparedProcedure.mode, "manual");
  assert.equal(preparedProcedure.memoryClass, "reference");
  const requiredProfile = { ...memo("利用者プロフィール", "required"), memoryClass: "profile",
    profileSummary: "所属: 経営企画部", content: "所属: 経営企画部\n非表示にする長い原文" };
  assert.deepEqual(rules.selectMemories([requiredProfile], "こんにちは").map((item) => item.id), [requiredProfile.id]);
  assert.match(rules.formatMemoryContext([requiredProfile]), /所属: 経営企画部/);
  assert.doesNotMatch(rules.formatMemoryContext([requiredProfile]), /非表示にする長い原文/);
  const profileResolution = await intelligence.resolveMemoryRelevance([
    requiredProfile,
    { ...memo("deploy", "manual"), content: "TestSite確認済みコミットとmainの重複を確認する" },
  ], "あなたが把握している私のプロフィール情報を教えて");
  assert.deepEqual(profileResolution.selected.map((item) => item.title), ["利用者プロフィール"]);
  assert.equal(profileResolution.uncertain, undefined);
  const memories = [
    memo("プロフィール", "always"),
    memo("TestSiteデプロイ", "required"),
    memo("本番デプロイ", "manual", "skill"),
  ];
  assert.deepEqual(rules.selectMemories(memories, "TestSiteにデプロイして").map((x) => x.title), ["プロフィール"]);
  assert.deepEqual(rules.selectMemories(memories, "TestSiteデプロイのskillを参照して").map((x) => x.title), ["プロフィール", "TestSiteデプロイ"]);
  assert.deepEqual(rules.selectMemories(memories, "本番デプロイの話をしよう").map((x) => x.title), ["プロフィール", "本番デプロイ"]);
  assert.deepEqual(rules.selectMemories(memories, "本番デプロイに従って進めて").map((x) => x.title), ["プロフィール", "本番デプロイ"]);
  const many = Array.from({ length: 8 }, (_, i) => memo(`毎回${i}`, "always", "memo"));
  assert.equal(rules.selectMemories(many, "こんにちは").length, 8);
  assert.equal(rules.selectMemories([{ ...many[0], enabled: false }], "参照して").length, 0);
  assert.equal(rules.memoryKind(memories[1]), "memo");
  assert.equal(rules.findNamedMemories([memo("A", "always"), memo("AB", "always")], "「AB」のメモを見せて").length, 1);
  assert.match(answerMemoryCommand({ kind: "show", query: "あのデプロイのメモ" }, memories), /複数のメモ/);

  for (const alias of ["メモ", "md", "MD"]) {
    const command = parse(`「日本語で回答する」を「回答方針」として${alias}に保存して。`);
    assert.equal(command.kind, "save");
    assert.equal(command.title, "回答方針");
    assert.equal(command.content, "日本語で回答する");
    assert.equal(command.mode, "manual");
  }
  for (const alias of ["スキル", "skill", "Skills"]) {
    const command = parse(`この内容を「検証手順」として${alias}に登録して。`, "まず結果を確認する");
    assert.equal(command.kind, "save");
    assert.equal(command.category, "memo");
    assert.equal(command.mode, "manual");
    assert.equal(command.title, "検証手順");
    assert.equal(command.content, "まず結果を確認する");
  }
  assert.equal(parse("この内容をデプロイ手順としてメモに残して。TestSiteでは必ず参照して", "手順").mode, "always");
  assert.equal(parse("この内容を「プロフィール」としてメモに保存して", "所属は経営企画部です").mode, "required");
  assert.equal(parse("この内容をメモに保存して").kind, "needs_content");
  assert.equal(parse("この内容を「保存名」としてMDに保存して").kind, "needs_content");
  const literal = parse("「skillは特定の手順。LearnedLessonとして記録して」を「説明」としてMDに保存して");
  assert.equal(literal.kind, "save");
  assert.equal(literal.category, "memo");
  assert.match(literal.content, /skillは/);
  assert.equal(parse("保存名は「方針」。メモに保存して。本文は「日本語で回答する」").content, "日本語で回答する");
  assert.deepEqual(parse("メモ「回答方針」の名前を「共通ルール」に変更して。"), { kind: "rename", query: "回答方針", title: "共通ルール" });
  assert.deepEqual(parse("共通ルールのメモを削除して"), { kind: "delete", query: "共通ルール" });
  assert.deepEqual(parse("skill「検証手順」を削除して"), { kind: "delete", query: "検証手順" });
  assert.equal(parse("md一覧を見せて").category, "memo");
  assert.equal(parse("skill一覧を見せて").category, "memo");
  assert.equal(parse("メモの一覧をみたい").category, "memo");
  assert.equal(parse("メモの一覧を出して").category, "memo");
  const unifiedList = answerMemoryCommand(parse("メモ一覧を見せて"), memories);
  assert.match(unifiedList, /プロフィール/);
  assert.match(unifiedList, /本番デプロイ/);
  assert.doesNotMatch(unifiedList, /Skill|スキル/);
  assert.equal(parse("この内容をメモに保存して。指定した時に参照して", "手順").mode, "manual");
  const storedJapanese = parse("以下を、\n# 運用手順\n必ず確認する\nメモで保管して");
  assert.equal(storedJapanese.kind, "save");
  assert.equal(storedJapanese.title, "運用手順");
  assert.equal(storedJapanese.content, "# 運用手順\n必ず確認する");
  assert.equal(parse("以下を、\n確認項目\nメモで保存して").content, "確認項目");
  const namedJapanese = parse("以下の内容を「デプロイメモ」として保存して", "# デプロイ\n/home/site/wwwroot");
  assert.equal(namedJapanese.kind, "save");
  assert.equal(namedJapanese.title, "デプロイメモ");
  const inlineProfile = parse(`以下の内容を「プロフィール」としてメモで保存して。

所属: 経営企画部
担当: DX・AI
入社年月: 2024年12月`);
  assert.equal(inlineProfile.kind, "save");
  assert.equal(inlineProfile.title, "プロフィール");
  assert.match(inlineProfile.content, /所属: 経営企画部/);
  assert.match(inlineProfile.content, /入社年月: 2024年12月/);
  assert.equal(inlineProfile.mode, "required");
  const naturalProfile = parse(`以下を私のプロフィール情報として、メモしておいて。
経営企画部所属 DX/ AI担当 主にAIシステムの開発、社内啓蒙を行っている。具体的には社内生成AI基盤のAzureChatおよび、議事録作成アプリ「議事郎」の開発、メンテ、社内啓蒙と行っている。2024年12月入社`);
  assert.equal(naturalProfile.kind, "save");
  assert.equal(naturalProfile.title, "プロフィール");
  assert.equal(naturalProfile.mode, "required");
  assert.match(naturalProfile.content, /経営企画部所属/);
  assert.match(naturalProfile.content, /議事郎/);
  assert.equal(namedJapanese.content, "# デプロイ\n/home/site/wwwroot");
  assert.equal(parse("LearnedLesson一覧を見せて").category, "lesson");
  assert.equal(parse("エラーでした。pushだけで完了扱いになりました。").kind, "learn");
  assert.equal(parse("エラーでした").kind, "learn");
  assert.equal(parse("エラーでしたか？"), undefined);
  assert.equal(parse("「エラーでした」を英訳して"), undefined);
  assert.equal(parse("TestSiteデプロイのskillを参照して"), undefined);
  assert.match(rules.formatMemoryContext(memories), /原因は検証されるまで未確認/);
  assert.ok(LESSON_MEMO_CONTENT.length < 150);
  const longLesson = buildLearnedLesson({ feedback: "指摘".repeat(10000), previousAssistant: "回答".repeat(10000),
    previousUser: "依頼".repeat(10000), reportedAt: "2026-10-02T00:00:00Z", suffix: "12345678" });
  assert.ok(longLesson.content.length <= 12000);
  assert.match(longLesson.content, /末尾を省略/);
  assert.match(longLesson.content, /未検証/);

  const input = { title: "回答方針", content: "日本語で回答する", kind: "memo", mode: "manual", triggers: [] };
  assert.equal(service.validateMemoryInput(input).mode, "manual");
  const legacy = await service.createUserMemory({ ...input, title: "旧スキル", kind: "skill", mode: "manual" });
  assert.equal(legacy.kind, "memo");
  assert.equal(legacy.mode, "manual");
  store({ ...legacy, kind: "skill" });
  const migrated = (await service.listUserMemories()).find(item => item.id === legacy.id);
  assert.equal(migrated.kind, "memo");
  assert.equal(migrated.mode, "manual");
  assert.equal(rules.selectMemories([migrated], "こんにちは").length, 0);
  assert.equal(rules.selectMemories([migrated], "「旧スキル」のメモを参照して").length, 1);
  const deployMemo = { ...memo("デプロイ手順", "manual", "memo"), triggers: ["TestSite", "デプロイ手順"] };
  assert.equal(rules.selectMemories([deployMemo], "デプロイメモを見てTestSiteのデプロイ先のDIRをおしえて").length, 1);
  assert.equal(rules.selectMemories([deployMemo], "デプロイメモを見ながらTestSiteの配置場所を教えて").length, 1);
  assert.equal(rules.selectMemories([deployMemo], "TestSiteのデプロイについて雑談しよう").length, 0);
  assert.equal(rules.selectMemories([deployMemo], "デプロイ手順によれば配置先はどこ？").length, 1);
  assert.deepEqual(rules.selectMemories([
    deployMemo, { ...memo("無効メモ", "manual"), enabled: false }, memo("運用手順", "manual"),
  ], "メモの中から、以下を教えて").map((item) => item.title), ["デプロイ手順", "運用手順"]);
  const edited = await service.renameUserMemory(migrated, "旧手順のメモ");
  assert.equal(edited.mode, "manual");
  await service.deleteUserMemory(edited.id);
  assert.throws(() => service.validateMemoryInput({ ...input, kind: "unknown" }), TypeError);
  assert.throws(() => service.validateMemoryInput({ ...input, content: "x".repeat(12001) }), TypeError);
  const created = await service.createUserMemory(input);
  await assert.rejects(service.createUserMemory({ ...input, title: " 回答方針 " }), /同じ保存名/);
  const renamed = await service.renameUserMemory(created, "共通ルール");
  assert.equal(renamed.version, 2);
  assert.equal(renamed.kind, "memo");
  assert.equal(renamed.content, created.content);
  await assert.rejects(service.renameUserMemory(created, "古い版"), /更新されています/);
  currentUser = "user-b";
  assert.deepEqual(await service.listUserMemories(), []);
  const bProfile = await service.createUserMemory({ ...input, title: "プロフィール", mode: "required", content: "私の勤務拠点は品川です。\n優先会議室：品川" });
  assert.equal(profileFacilityPreference(await service.listUserMemories()), "品川");
  currentUser = "user-a";
  assert.equal(profileFacilityPreference(await service.listUserMemories()), undefined);
  currentUser = "user-b";
  await service.deleteUserMemory(bProfile.id);
  await assert.rejects(service.deleteUserMemory(created.id), /見つかりません/);
  currentUser = "user-a";
  await service.deleteUserMemory(renamed.id);
  assert.deepEqual(await service.listUserMemories(), []);

  const props = { feedback: "エラーでした。手動Workflowが未実行でした。", threadId: "thread-a",
    previousAssistant: "pushしました。デプロイ完了です。", previousUser: "TestSiteに反映して" };
  const lesson = await service.recordLearnedLesson(props);
  assert.equal(lesson.detail.kind, "memo");
  assert.equal(lesson.detail.mode, "manual");
  assert.equal(lesson.detail.learnedLesson.status, "reported");
  assert.match(lesson.detail.content, /手動Workflowが未実行/);
  assert.match(lesson.detail.content, /デプロイ完了です/);
  assert.match(lesson.detail.content, /TestSiteに反映して/);
  const second = await service.recordLearnedLesson({ ...props, feedback: "エラーでした。ビルドが失敗しました。" });
  let items = await service.listUserMemories();
  assert.equal(items.filter((item) => item.mode === "always").length, 1);
  assert.equal(items.filter((item) => item.mode === "manual").length, 2);
  assert.deepEqual(rules.selectMemories(items, "こんにちは").map((item) => item.id), [lesson.memo.id]);
  assert.equal(rules.selectMemories(items, `「${second.detail.title}」のskillを参照して`).length, 2);
  const renamedLesson = await service.renameUserMemory(lesson.detail, "Workflow失敗");
  assert.equal(renamedLesson.learnedLesson.threadId, "thread-a");
  failBatch = true;
  const count = documents.size;
  await assert.rejects(service.recordLearnedLesson(props), /保存できません/);
  assert.equal(documents.size, count);
  failBatch = false;
  await service.deleteUserMemory(lesson.memo.id);
  const revived = await service.recordLearnedLesson(props);
  assert.equal(revived.memo.version, 3);
  assert.equal(revived.memo.enabled, true);
  currentUser = "user-c";
  raceMemo = true;
  const calls = batchCalls;
  await service.recordLearnedLesson(props);
  assert.equal(batchCalls - calls, 2);
  assert.equal((await service.listUserMemories()).length, 2);
  currentUser = undefined;
  await assert.rejects(service.listUserMemories(), /User not found/);
  currentUser = "user-a";

  history = [{ role: "assistant", content: "所属は経営企画部です。通常はアクトを希望します。" },
    { role: "user", content: "プロフィールをまとめて" }];
  let response = await handle({ message: "以下の内容を「会議プロフィール」として保存して", threadId: "thread-a",
    userName: "User", memories: await service.listUserMemories() });
  assert.match(await response.text(), /会議プロフィール.*保存しました/);
  const savedProfile = (await service.listUserMemories()).find((item) => item.title === "会議プロフィール");
  assert.equal(savedProfile.mode, "required");
  assert.match(savedProfile.profileSummary, /経営企画部/);

  history = [{ role: "assistant", content: "確認せず完了と言いました。" }, { role: "user", content: "反映してください" }];
  response = await handle({ message: "エラーでした。保存名は「反映確認の失敗」", threadId: "thread-a", userName: "User", memories: await service.listUserMemories() });
  const learnedResponse = await response.text();
  assert.match(learnedResponse, /LearnedLessonを記録/);
  assert.match(learnedResponse, /詳細・再確認手順: メモ/);
  assert.doesNotMatch(learnedResponse, /Skill|スキル|skill/);
  items = await service.listUserMemories();
  const recorded = items.find((item) => item.title === "反映確認の失敗");
  assert.match(recorded.content, /確認せず完了/);
  response = await handle({ message: "skill「反映確認の失敗」の名前を「完了報告の検証」に変更して", threadId: "thread-a", userName: "User", memories: items });
  assert.match(await response.text(), /完了報告の検証/);
  response = await handle({ message: "skill「完了報告の検証」を削除して", threadId: "thread-a", userName: "User", memories: await service.listUserMemories() });
  assert.match(await response.text(), /以後参照しません/);
  assert.ok(!(await service.listUserMemories()).some((item) => item.id === recorded.id));
  const before = documents.size;
  response = await handle({ message: "デプロイのメモを削除して", threadId: "thread-a", userName: "User",
    memories: [memo("本番デプロイ", "manual"), memo("TestSiteデプロイ", "manual")] });
  assert.match(await response.text(), /複数のメモ/);
  assert.equal(documents.size, before);
  assert.equal(await handle({ message: "通常の質問", threadId: "thread-a", userName: "User", memories: items }), undefined);
  assert.ok(messages.length > 0);
  console.log("memory PoC checks passed (rules, commands, learned lessons, storage mock, chat handler)");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
