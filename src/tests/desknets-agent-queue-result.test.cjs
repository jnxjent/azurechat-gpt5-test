const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function loadClient(fetchResponses, calls) {
  const source = readFileSync("features/desknets-agent/desknets-agent-client.ts", "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (name) => {
    if (name === "server-only") return {};
    if (name === "./desknets-agent-transport") {
      return {
        fetchDeskNetsAgent: async (url, init) => {
          calls.push({ url, method: init.method });
          const next = fetchResponses.shift();
          assert.ok(next, "unexpected Agent API request");
          return new Response(JSON.stringify(next.body), {
            status: 202,
            headers: next.headers,
          });
        },
        deskNetsTransportMessage: () => "transport failed",
      };
    }
    if (name === "@/features/auth-page/helpers") {
      return {
        userHashedId: async () => "a".repeat(64),
        userSession: async () => ({ email: "user@example.invalid" }),
      };
    }
    if (name === "next-auth/jwt") return { getToken: async () => null };
    throw new Error(`Unexpected dependency: ${name}`);
  };
  Function("require", "exports", "module", javascript)(localRequire, loaded.exports, loaded);
  return loaded.exports;
}

test("an active run returns its numbered candidates to the chat turn", async () => {
  const previous = process.env.DESKNETS_AGENT_API_URL;
  process.env.DESKNETS_AGENT_API_URL = "http://agent.invalid";
  try {
    const calls = [];
    const client = loadClient([
      { body: { id: "run-1", status: "running" }, headers: { "x-desknets-async-queue": "1" } },
      { body: { id: "run-1", status: "completed", result: { assistantMessage: "1. 月曜 10:30〜11:30" } } },
    ], calls);
    const result = await client.runDeskNetsAgent("来週月曜日で候補を挙げて", "thread-1");
    assert.equal(result.result.assistantMessage, "1. 月曜 10:30〜11:30");
    assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
  } finally {
    if (previous === undefined) delete process.env.DESKNETS_AGENT_API_URL;
    else process.env.DESKNETS_AGENT_API_URL = previous;
  }
});

test("a waiting run leaves a queue card to show progress", async () => {
  const previous = process.env.DESKNETS_AGENT_API_URL;
  process.env.DESKNETS_AGENT_API_URL = "http://agent.invalid";
  try {
    const calls = [];
    const client = loadClient([
      { body: { id: "run-2", status: "queued" }, headers: { "x-desknets-async-queue": "1" } },
    ], calls);
    const result = await client.runDeskNetsAgent("候補を挙げて", "thread-2");
    assert.equal(result.status, "queued");
    assert.deepEqual(calls.map((call) => call.method), ["POST"]);
  } finally {
    if (previous === undefined) delete process.env.DESKNETS_AGENT_API_URL;
    else process.env.DESKNETS_AGENT_API_URL = previous;
  }
});

test("an active selection returns the approval card in the same turn", async () => {
  const previous = process.env.DESKNETS_AGENT_API_URL;
  process.env.DESKNETS_AGENT_API_URL = "http://agent.invalid";
  try {
    const calls = [];
    const approvalRequest = {
      title: "打ち合わせ",
      start: "2026-09-28T10:30:00+09:00",
      end: "2026-09-28T11:30:00+09:00",
    };
    const client = loadClient([
      { body: { id: "run-3", status: "running" }, headers: { "x-desknets-async-queue": "1" } },
      { body: { id: "run-3", status: "awaiting_approval", result: { approvalRequest } } },
    ], calls);
    const result = await client.runDeskNetsAgent("では1で", "thread-3");
    assert.deepEqual(result.result.approvalRequest, approvalRequest);
    assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
  } finally {
    if (previous === undefined) delete process.env.DESKNETS_AGENT_API_URL;
    else process.env.DESKNETS_AGENT_API_URL = previous;
  }
});
