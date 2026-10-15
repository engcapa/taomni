import { test } from "node:test";
import assert from "node:assert/strict";
import { domains, extract } from "./update-model-inspector-snapshot.mjs";
test("all provider subtrees require matching domains and nonempty models", () => {
  const source = Object.fromEntries(Object.entries(domains).map(([key, domain]) =>
    [key, { api: `https://${domain}/v1`, models: { model: { name: "Fixture" } } }]));
  assert.deepEqual(Object.keys(extract(source)), Object.keys(domains));
  assert.throws(() => extract({ ...source, deepseek: { api: "https://evil.example", models: { m: {} } } }), /Unexpected domain/);
  assert.throws(() => extract({ ...source, groq: { models: {} } }), /Missing subtree/);
  const native = { ...source, anthropic: { doc: "https://docs.anthropic.com/models", models: { m: {} } } };
  assert.ok(extract(native).anthropic);
});
