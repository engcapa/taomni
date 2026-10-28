import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./qa_ui_auto/language_startup_observer.js", import.meta.url), "utf8");

function harness(invoke) {
  let now = 0;
  const window = {};
  const install = vm.runInNewContext(`(${source})`, {
    window, performance: { now: () => ++now },
  });
  const target = { invoke };
  const result = install(target);
  assert.equal(result.installed, true);
  return { window, target, install, observer: window.__taomniQaLanguageStartup };
}

test("forwards real invocation receiver, arguments, options and result while observing pending", async () => {
  let release;
  const result = { provider: "actual" };
  const args = { workspaceId: "ws", rootPath: "/fixture", text: "SECRET_SOURCE", password: "SECRET_PASSWORD" };
  const options = { signal: "actual-option" };
  let seen;
  const h = harness(function (...values) {
    seen = { receiver: this, values };
    return new Promise((resolve) => { release = resolve; });
  });
  const invocation = h.target.invoke("lsp_open_document", args, options);
  assert.equal(seen.receiver, h.target);
  assert.deepEqual(seen.values, ["lsp_open_document", args, options]);
  const event = h.observer.observe().events[0];
  assert.equal(event.status, "pending");
  assert.equal(event.workspaceId, "ws");
  assert.equal(event.rootPath, "/fixture");
  assert.equal(JSON.stringify(h.observer.observe()).includes("SECRET"), false);
  release(result);
  assert.equal(await invocation, result);
  assert.equal(h.observer.observe().events[0].status, "fulfilled");
  assert.equal(JSON.stringify(h.observer.observe()).includes("actual"), false);
  event.status = "modified-copy";
  assert.equal(h.observer.observe().events[0].status, "fulfilled");
});

test("preserves both synchronous throws and actual asynchronous rejection identities", async () => {
  const failure = new Error("private provider failure");
  const sync = harness(() => { throw failure; });
  assert.throws(() => sync.target.invoke("sdk_resolve_workspace"), (error) => error === failure);
  assert.equal(sync.observer.observe().events[0].status, "rejected");
  const async = harness(() => Promise.reject(failure));
  await assert.rejects(async.target.invoke("sdk_resolve_workspace"), (error) => error === failure);
  assert.equal(async.observer.observe().events[0].status, "rejected");
  assert.equal(JSON.stringify(async.observer.observe()).includes(failure.message), false);
});

test("leaves unobserved commands and their original promises unchanged", () => {
  const actual = Promise.resolve("ordinary-command");
  const h = harness(() => actual);
  assert.equal(h.target.invoke("workspace_read_file", { text: "private" }), actual);
  assert.equal(h.observer.observe().events.length, 0);
});

test("restore respects ownership and a duplicate install fails instead of stacking wrappers", () => {
  const original = () => Promise.resolve(null);
  const h = harness(original);
  assert.throws(() => h.install(h.target), /already installed/);
  const installed = h.target.invoke;
  h.target.invoke = () => Promise.resolve("another-owner");
  assert.throws(() => h.observer.restore(), /owner changed/);
  h.target.invoke = installed;
  h.observer.restore();
  assert.equal(h.target.invoke, original);
  assert.equal(h.window.__taomniQaLanguageStartup, undefined);
});

test("a readonly Tauri invoke cannot silently install an ineffective observer", () => {
  const h = harness(() => Promise.resolve(null));
  h.observer.restore();
  const original = h.target.invoke;
  Object.defineProperty(h.target, "invoke", { value: original, writable: false, configurable: false });
  assert.throws(() => h.install(h.target), /not writable/);
  assert.equal(h.target.invoke, original);
  assert.equal(h.window.__taomniQaLanguageStartup, undefined);
});
