const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function loadIntentModule() {
  const source = readFileSync(
    "features/desknets-agent/desknets-agent-intent.ts",
    "utf8"
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("exports", "module", javascript)(loaded.exports, loaded);
  return loaded.exports;
}

const { shouldRouteToDeskNetsAgent } = loadIntentModule();
const recentDeskNetsHistory = [
  { role: "assistant", content: "DeskNet'sで候補を確認しました。" },
];
const actualAvailabilityHistory = [
  {
    role: "assistant",
    content:
      "はい。9月14日は、現在以降では08:00〜10:00、12:00〜13:00、15:00〜17:00の範囲で60分の打ち合わせを設定可能です。日付を開いて候補を確認するか、日時・会議室・メール送信有無を直接指定してください。",
  },
];

test("routes an initial scheduling request", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent(
      "今日、私と甲斐さんが打ち合わせ可能な日時の候補を教えて",
      []
    ),
    true
  );
});

test("accepts common DeskNet's product-name spellings", () => {
  for (const productName of [
    "desknets",
    "DeskNets",
    "DeskNet's",
    "DeskNet’s",
    "DeskNet",
    "デスクネッツ",
    "デスクネット",
  ]) {
    assert.equal(
      shouldRouteToDeskNetsAgent(`${productName}で来週の空き時間を確認して`, []),
      true,
      productName
    );
  }
});

test("does not route an unrelated message containing only 予定", () => {
  assert.equal(shouldRouteToDeskNetsAgent("明日の予定を整理して", []), false);
});

test("routes a narrow follow-up when recent DeskNet's context exists", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent("候補2でお願いします", recentDeskNetsHistory),
    true
  );
  assert.equal(
    shouldRouteToDeskNetsAgent(
      "では12:00〜13:00で確定したい",
      recentDeskNetsHistory
    ),
    true
  );
});

test("keeps routing from the actual availability response even when tool messages are omitted", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent(
      "では、12時―13時で確定したい",
      actualAvailabilityHistory
    ),
    true
  );
  assert.equal(
    shouldRouteToDeskNetsAgent(
      "会議室は、アクトの空いている会議室にして",
      actualAvailabilityHistory
    ),
    true
  );
  assert.equal(
    shouldRouteToDeskNetsAgent(
      "では、以下で。\n12:00〜13:00",
      actualAvailabilityHistory
    ),
    true
  );
  assert.equal(
    shouldRouteToDeskNetsAgent(
      "では以下で。\n12:00開始",
      actualAvailabilityHistory
    ),
    true
  );
});

test("routes natural-language room changes while DeskNet's scheduling is active", () => {
  for (const message of [
    "会議室を、アクト応接室に変えて。あいてなければ、アクトの会議室ならどこでもいい。",
    "アクト応接室にかえて、空いていなかったらアクトの会議室どこでもいい",
    "応接室をアクト応接室に変更してください",
  ]) {
    assert.equal(
      shouldRouteToDeskNetsAgent(message, actualAvailabilityHistory),
      true,
      message
    );
  }
});

test("lets the NL analyzer interpret a room-related paraphrase in the active turn", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent(
      "場所、やっぱりアクト応接室。だめならアクト内ならどこでも",
      actualAvailabilityHistory
    ),
    true
  );
});

test("does not treat an old active marker behind a newer user turn as active", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent("会議室について一般論を教えて", [
      ...actualAvailabilityHistory,
      { role: "user", content: "別の話題にします" },
      { role: "assistant", content: "承知しました。" },
    ]),
    false
  );
});

test("routes a short room reply after an unavailable-room response", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent("では、ミーティングルームCで", [
      {
        role: "assistant",
        content:
          "指定した会議室「アクト応接室」は、指定した日時には埋まっています。別の会議室を指定してください。",
      },
    ]),
    true
  );
});

test("does not hijack an unrelated message after DeskNet's usage", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent("売上を教えて", recentDeskNetsHistory),
    false
  );
});

const facilityChoiceHistory = [
  {
    role: "tool",
    name: "desknets_schedule_agent",
    content: JSON.stringify({
      status: "awaiting_user_input",
      message:
        "会議室の場所はどこにしますか？\n・アクト\n・有玉本社\n・品川オフィス\nいずれかの名称で答えてください。",
    }),
  },
  {
    role: "assistant",
    content: "どちらの会議室になさいますか？アクト、有玉本社、品川オフィスからお選びください。",
  },
];

test("routes a bare facility name reply to the facility-choice question", () => {
  assert.equal(shouldRouteToDeskNetsAgent("有玉", facilityChoiceHistory), true);
  assert.equal(shouldRouteToDeskNetsAgent("アクト", facilityChoiceHistory), true);
  assert.equal(
    shouldRouteToDeskNetsAgent("品川オフィス", facilityChoiceHistory),
    true
  );
  assert.equal(
    shouldRouteToDeskNetsAgent("有玉にして", facilityChoiceHistory),
    true
  );
});

test("does not treat a bare short reply as a facility choice without the question in context", () => {
  assert.equal(shouldRouteToDeskNetsAgent("有玉", recentDeskNetsHistory), false);
  assert.equal(shouldRouteToDeskNetsAgent("有玉", []), false);
});

test("routes a request to go back to the previous candidates", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent("候補に戻して", recentDeskNetsHistory),
    true
  );
  assert.equal(
    shouldRouteToDeskNetsAgent("やっぱりやめて、候補に戻して", recentDeskNetsHistory),
    true
  );
});

const participantChoiceHistory = [
  {
    role: "tool",
    name: "desknets_schedule_agent",
    content: JSON.stringify({
      status: "awaiting_user_input",
      message:
        "山本さんが複数見つかりました。どちらですか？\n・経営企画部\n・三晃\n組織名で答えてください。",
    }),
  },
  {
    role: "assistant",
    content: "山本さんという名前の方が複数いらっしゃいます。経営企画部の方でしょうか、三晃の方でしょうか？",
  },
];

test("routes a bare organization name reply to the participant-choice question", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent("経営企画部", participantChoiceHistory),
    true
  );
  assert.equal(shouldRouteToDeskNetsAgent("三晃", participantChoiceHistory), true);
});

test("does not treat a bare organization name as a participant choice without the question in context", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent("経営企画部", recentDeskNetsHistory),
    false
  );
  assert.equal(shouldRouteToDeskNetsAgent("経営企画部", []), false);
});

const staleFacilityChoiceHistory = [
  {
    role: "tool",
    name: "desknets_schedule_agent",
    content: JSON.stringify({
      message: "会議室の場所はどこにしますか？\n・アクト\n・有玉本社\nいずれかの名称で答えてください。",
    }),
  },
  { role: "assistant", content: "どちらの会議室になさいますか？" },
  { role: "user", content: "有玉" },
  {
    role: "tool",
    name: "desknets_schedule_agent",
    content: JSON.stringify({ message: "予約フォームを開きました。" }),
  },
];

test("does not keep routing after the facility-choice question has already been answered", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent("売上を教えて", staleFacilityChoiceHistory),
    false
  );
});

const staleParticipantChoiceHistory = [
  {
    role: "tool",
    name: "desknets_schedule_agent",
    content: JSON.stringify({
      message: "山本さんが複数見つかりました。どちらですか？\n・経営企画部\n・三晃\n組織名で答えてください。",
    }),
  },
  { role: "assistant", content: "経営企画部の方でしょうか、三晃の方でしょうか？" },
  { role: "user", content: "三晃" },
  {
    role: "tool",
    name: "desknets_schedule_agent",
    content: JSON.stringify({ message: "空き時間の候補が見つかりました。" }),
  },
];

test("does not keep routing after the participant-choice question has already been answered", () => {
  assert.equal(
    shouldRouteToDeskNetsAgent("売上を教えて", staleParticipantChoiceHistory),
    false
  );
});
