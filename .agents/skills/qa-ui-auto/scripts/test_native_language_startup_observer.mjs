import assert from "node:assert/strict";
import test from "node:test";
import { harness, installed } from "./native_language_observer_harness.mjs";

test("verifies a real control callback while preserving Tauri's read-only invoke", async () => {
  for (const protocol of ["ipc://localhost/", "http://ipc.localhost/", "https://ipc.localhost/"]) {
    const h = harness({ protocol });
    const descriptor = Object.getOwnPropertyDescriptor(h.target, "invoke");
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    h.install();
    assert.equal(h.observer().observe().valid, false);
    assert.equal(h.observer().observe().transportProbe.observed, true);
    assert.equal(h.observer().observe().transportProbe.status, "pending");
    await h.complete(h.requests[0], "PRIVATE_APP_NAME");
    assert.equal(h.observer().observe().valid, true);
    assert.equal(h.observer().observe().events.length, 0);
    assert.equal(h.target.invoke, h.invoke);
    assert.deepEqual(Object.getOwnPropertyDescriptor(h.target, "invoke"), descriptor);
    assert.equal(h.callbacks.size, 0);
    assert.equal(JSON.stringify(h.observer().observe()).includes("PRIVATE"), false);
  }
});

test("observes pending and actual completion, forwards bytes, options and result without recording them", async () => {
  const h = await installed();
  const payload = { text: "SECRET_SOURCE", password: "SECRET_PASSWORD" };
  const result = { content: "SECRET_NATIVE_RESULT" };
  const promise = h.target.invoke("lsp_open_document", payload, { headers: { "Custom-Header": "SECRET_HEADER" } });
  const request = h.requests.at(-1);
  assert.equal(request.args[1].body, payload);
  assert.equal(request.args[1].headers.get("Custom-Header"), "SECRET_HEADER");
  assert.equal(request.receiver, h.window);
  const event = h.observer().observe().events[0];
  assert.equal(event.status, "pending");
  assert.equal(event.command, "lsp_open_document");
  await h.complete(request, result);
  assert.equal(await promise, result);
  assert.equal(h.callbacks.size, 0);
  assert.equal(h.observer().observe().events[0].status, "fulfilled");
  assert.equal(JSON.stringify(h.observer().observe()).includes("SECRET"), false);
  event.status = "modified-copy";
  assert.equal(h.observer().observe().events[0].status, "fulfilled");
});

test("preserves real native rejection and callback unregister semantics", async () => {
  const h = await installed();
  const failure = { native: "SECRET_NATIVE_ERROR" };
  const promise = h.target.invoke("sdk_resolve_workspace", { text: "SECRET" });
  const check = assert.rejects(promise, (error) => error === failure);
  await h.complete(h.requests.at(-1), failure, true);
  await check;
  assert.equal(h.observer().observe().events[0].status, "rejected");
  assert.equal(h.callbacks.size, 0);
  assert.equal(h.observer().observe().valid, true);
  assert.equal(JSON.stringify(h.observer().observe()).includes("SECRET"), false);
});

test("fetch wrapper preserves the original promise and synchronous callback throws", async () => {
  const h = await installed();
  const failure = new Error("SECRET_CALLBACK_FAILURE");
  const callbackId = 1000, errorId = 1001;
  const callback = () => { throw failure; };
  h.callbacks.set(callbackId, callback);
  h.callbacks.set(errorId, () => {});
  const resource = new URL("ipc://localhost/sdk_get_registry");
  const options = { headers: { "Tauri-Callback": callbackId, "Tauri-Error": errorId }, body: "SECRET" };
  const receiver = { real: "receiver" };
  const promise = h.window.fetch.call(receiver, resource, options, "forwarded-option");
  const request = h.requests.at(-1);
  assert.equal(promise, request.promise);
  assert.equal(request.receiver, receiver);
  assert.deepEqual(request.args, [resource, options, "forwarded-option"]);
  assert.throws(() => h.target.runCallback(callbackId, "SECRET"), (error) => error === failure);
  assert.equal(h.observer().observe().events[0].status, "fulfilled");
  h.observer().restore();
  assert.equal(h.callbacks.get(callbackId), callback);
  request.resolve(null);
});

test("unrelated fetch and ordinary commands retain their promise and never enter SDK counts", async () => {
  const h = await installed();
  const resource = "https://example.invalid/sdk_get_registry";
  const options = { body: "SECRET_EXTERNAL_BODY" };
  const promise = h.window.fetch(resource, options);
  assert.equal(promise, h.requests.at(-1).promise);
  h.requests.at(-1).resolve("real-network-response");
  assert.equal(await promise, "real-network-response");
  const invocation = h.target.invoke("workspace_read_file", { text: "SECRET" });
  await h.complete(h.requests.at(-1), "real-file-response");
  assert.equal(await invocation, "real-file-response");
  assert.equal(h.observer().observe().events.length, 0);
  const reads = h.observer().observe().fileReads;
  assert.equal(reads.length, 1);
  assert.equal(reads[0].command, "workspace_read_file");
  assert.equal(reads[0].status, "fulfilled");
  assert.ok(reads[0].finishedEpochMs >= reads[0].startedEpochMs);
  assert.equal(JSON.stringify(reads).includes("SECRET"), false);
});

test("restore returns pending callbacks to Tauri and refuses another owner's changes", async () => {
  const h = await installed();
  assert.throws(h.install, /already installed/);
  const pending = h.target.invoke("sdk_resolve_workspace");
  const request = h.requests.at(-1);
  const id = Number(request.args[1].headers.get("Tauri-Callback"));
  const wrapped = h.callbacks.get(id);
  h.callbacks.set(id, () => {});
  assert.throws(() => h.observer().restore(), /callback owner changed/);
  h.callbacks.set(id, wrapped);
  const wrapper = h.window.fetch;
  h.window.fetch = () => {};
  assert.throws(() => h.observer().restore(), /transport owner changed/);
  h.window.fetch = wrapper;
  h.observer().restore();
  assert.equal(h.window.fetch, h.originalFetch);
  assert.equal(h.observer(), undefined);
  await h.complete(request, "actual-result-after-restore");
  assert.equal(await pending, "actual-result-after-restore");
  assert.equal(h.callbacks.size, 0);
});

test("readonly fetch and absent callback Map cannot install a silently ineffective observer", () => {
  const readonly = harness({ readonlyFetch: true });
  assert.throws(readonly.install, /not writable/);
  assert.equal(readonly.observer(), undefined);
  const missing = harness();
  missing.callbacks.get = null;
  assert.throws(missing.install, /unavailable/);
  assert.equal(missing.observer(), undefined);
});

test("postMessage fallback and rejected control command fail closed", async () => {
  const fallback = harness({ fallback: true });
  fallback.install();
  await fallback.flush();
  assert.equal(fallback.observer().observe().valid, false);
  assert.equal(fallback.observer().observe().observationError, "control-request-bypassed-observer");
  const rejected = harness();
  rejected.install();
  await rejected.complete(rejected.requests[0], "PRIVATE_DENIAL", true);
  assert.equal(rejected.observer().observe().valid, false);
  assert.equal(rejected.observer().observe().observationError, "control-request-rejected");
});

test("a later protocol failure invalidates zero counts even for an unwatched command", async () => {
  const h = await installed();
  const invocation = h.target.invoke("workspace_read_file");
  h.requests.at(-1).reject(new Error("SECRET_TRANSPORT_ERROR"));
  await h.flush();
  assert.equal(await invocation, "PRIVATE_FALLBACK_RESPONSE");
  const state = h.observer().observe();
  assert.equal(state.valid, false);
  assert.equal(state.observationError, "custom-protocol-failed");
  assert.equal(state.events.length, 0);
  assert.equal(JSON.stringify(state).includes("SECRET"), false);
});

test("missing real callback headers invalidate observation while the native fetch still proceeds", async () => {
  const h = await installed();
  const original = { method: "POST", body: "SECRET" };
  const promise = h.window.fetch("ipc://localhost/sdk_get_registry", original);
  assert.equal(h.requests.at(-1).args[1], original);
  assert.equal(promise, h.requests.at(-1).promise);
  h.requests.at(-1).resolve(null);
  await promise;
  assert.equal(h.observer().observe().valid, false);
  assert.equal(h.observer().observe().observationError, "real-callback-header-unavailable");
});
