const assert = require("node:assert/strict");
const { createDecipheriv, randomBytes } = require("node:crypto");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const javascript = ts.transpileModule(
  readFileSync("features/desknets-agent/credential-envelope.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const loaded = { exports: {} };
Function("require", "exports", "module", javascript)(
  (name) => name === "server-only" ? {} : require(name),
  loaded.exports,
  loaded,
);

test("encrypts DeskNet's password for only the matching VM user", () => {
  const key = randomBytes(32);
  const userId = "a".repeat(64);
  const envelope = loaded.exports.sealDeskNetsCredentials(
    userId, "employee", "local-test-secret", key.toString("base64url"),
  );
  assert.equal(JSON.stringify(envelope).includes("local-test-secret"), false);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
  decipher.setAAD(Buffer.from(`v1:${userId}:${envelope.issuedAt}`, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  assert.deepEqual(JSON.parse(plaintext.toString("utf8")), {
    username: "employee", password: "local-test-secret",
  });
});
