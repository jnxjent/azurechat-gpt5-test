const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const childrenOnly = ({ children }) => React.createElement("div", null, children);
function loadComponent(path, imports) {
  const javascript = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = { exports: {} };
  const resolve = (name) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    if (["react", "react/jsx-runtime"].includes(name)) return require(name);
    throw new Error(`Unexpected import: ${name}`);
  };
  Function("require", "exports", "module", javascript)(resolve, loaded.exports, loaded);
  return loaded.exports;
}

const icons = Object.fromEntries(
  ["Download", "FunctionSquare", "CheckCircle2", "Loader2", "RotateCcw"].map(name => [name, () => null])
);
const store = { chatStore: {}, useChat: () => ({ loading: false }) };
const card = loadComponent("features/desknets-agent/desknets-approval-card.tsx", {
  "@/features/chat-page/chat-store": store,
  "lucide-react": icons,
});
const { default: MessageContent } = loadComponent("features/chat-page/message-content.tsx", {
  "@/features/desknets-agent/desknets-approval-card": card,
  "@/features/desknets-agent/desknets-queue-card": { DeskNetsQueueCard: () => null },
  "@/features/ui/markdown/markdown": { Markdown: ({ content }) => React.createElement("p", null, content) },
  "@/lib/linkifyPhone": { splitTextWithPhones: text => [{ type: "text", value: text }] },
  "lucide-react": icons,
  "../ui/accordion": Object.fromEntries(["Accordion", "AccordionContent", "AccordionItem", "AccordionTrigger"].map(name => [name, childrenOnly])),
  "../ui/recursive-ui": { RecursiveUI: () => React.createElement("div", null, "raw tool output") },
  "./citation/citation-action": { CitationAction: () => {} },
  "./chat-store": store,
});

const approval = {
  integration: "desknets_schedule_agent", status: "awaiting_approval",
  runId: "test-run", chatThreadId: "test-thread",
  approvalRequest: {
    title: "打ち合わせ", start: "2026-09-18T06:00:00.000Z", end: "2026-09-18T07:00:00.000Z",
    participantIds: ["参加者A", "参加者B", "参加者C"], nativeUserIds: ["186", "5", "6"],
    facilityId: "会議室C", emailNotificationWillBeSent: true,
  },
};
function render(role, value) {
  return renderToStaticMarkup(React.createElement(MessageContent, {
    message: { role, name: "tool", content: JSON.stringify(value) },
  }));
}
for (const role of ["tool", "function"]) {
  test(`${role} result renders the real approval card outside the raw tool output`, () => {
    const html = render(role, approval);
    assert.match(html, /desknet(?:&#x27;|&#39;|')sを開く/);
    assert.doesNotMatch(html, /実行側Edge|議題をコピー|このPCへの引き渡し|Alt \+ Tab/);
    assert.match(html, /参加者A、参加者B、参加者C/);
    assert.ok(html.indexOf("sを開く") < html.indexOf("raw tool output"));
  });
}
test("unrelated, malformed and candidate-only results do not render approval buttons", () => {
  for (const value of [null, "not JSON data", {}, { status: "awaiting_user_input" }, { ...approval, approvalRequest: null }]) {
    assert.doesNotMatch(render("tool", value), /このPCのDeskNet|議題をコピー/);
  }
});
