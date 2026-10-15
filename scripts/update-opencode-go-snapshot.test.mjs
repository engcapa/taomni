import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, protocol } from "./update-opencode-go-snapshot.mjs";
test("metadata mapping respects shape and all four SDKs", () => {
  assert.equal(protocol({ provider: { npm: "@ai-sdk/openai", shape: "completions" } }, {}), "chat");
  for (const [npm, expected] of [["openai-compatible","chat"],["openai","responses"],["anthropic","messages"],["google","google"]]) {
    assert.equal(protocol({}, { npm: `@ai-sdk/${npm}` }), expected);
  }
});
test("seed conflicts fail explicitly; missing catalog fails; unknown metadata is tolerated", () => {
  const seed = { models: { a: "responses" } };
  assert.throws(() => validate({ npm: "@ai-sdk/google", models: { a: {} } }, seed), /Protocol conflict/);
  assert.throws(() => validate({}, seed), /Missing/);
  validate({ npm: "future-sdk", models: { a: {} } }, seed);
});
