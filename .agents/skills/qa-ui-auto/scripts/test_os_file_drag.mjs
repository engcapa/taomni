import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./qa_ui_auto/os_file_drag.js", import.meta.url), "utf8");

function harness({ dpr = 2, label = "actual-webview", pointMode = "child" } = {}) {
  const events = [], emissions = [], mutations = [];
  const rect = { left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 };
  const attrs = { "data-testid": "code-workspace-tree-dir", "data-root-id": "root2", "data-path": "incoming", "data-tree-kind": "dir" };
  const element = { tagName: "BUTTON", getAttribute: (key) => attrs[key] ?? null, getBoundingClientRect: () => rect };
  const child = {
    tagName: "SPAN", getAttribute: () => null,
    closest: () => attrs["data-tree-kind"] ? element : null,
    dispatchEvent(event) { events.push({ target: child, event }); event.preventDefault(); return false; },
  };
  element.closest = child.closest;
  element.contains = (hit) => hit === element || hit === child;
  element.dispatchEvent = (event) => { events.push({ target: element, event }); return true; };
  const covered = { tagName: "DIV", getAttribute: () => null, closest: () => null };
  let matches = [element], status = "Ready";
  const document = {
    body: element,
    querySelectorAll: () => matches,
    querySelector: () => ({ textContent: status }),
    elementFromPoint: (x, y) => pointMode === "occluded" ? covered : pointMode === "child" ? child : element,
  };
  class DataTransfer {
    constructor() { this.data = new Map(); }
    setData(type, value) { this.data.set(type, value); }
    getData(type) { return this.data.get(type) ?? ""; }
    get types() { return [...this.data.keys()]; }
  }
  class DragEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); this.isTrusted = false; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { mutations.push(this); }
    disconnect() { this.disconnected = true; }
  }
  const tauri = {
    webview: { getCurrentWebview: () => ({ label }) },
    event: { emitTo: async (...args) => { emissions.push(args); status = "Importing 3 item(s)…"; mutations.forEach((m) => m.callback()); } },
  };
  const window = {
    innerWidth: 800, innerHeight: 600, devicePixelRatio: dpr, __TAURI__: tauri,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    requestAnimationFrame: (callback) => { queueMicrotask(callback); },
  };
  const run = vm.runInNewContext(`(${source})`, { document, window, DataTransfer, DragEvent, MutationObserver });
  const request = (extra = {}) => ({ mode: "browser", phase: "drop", selector: "#directory", paths: ["/中文 file.txt"], uriList: "file:///%E4%B8%AD%E6%96%87%20file.txt", ...extra });
  return { run, request, document, window, tauri, element, child, rect, attrs, events, emissions, mutations,
    setMatches: (values) => { matches = values; } };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("all HTML5 phases dispatch bubbling/cancelable real DOM event objects with URI data", async () => {
  const h = harness();
  for (const [phase, name] of Object.entries({ enter: "dragenter", over: "dragover", drop: "drop", leave: "dragleave" })) {
    const observation = await h.run(h.request({ phase }));
    assert.equal(observation.ok, true);
    assert.equal(observation.eventName, name);
    assert.equal(observation.synthetic, true);
    assert.equal(observation.physicalOsGesture, false);
    assert.equal(observation.isTrusted, false);
    const { target, event } = h.events.at(-1);
    assert.equal(target, h.child);
    assert.equal(event.type, name);
    assert.equal(event.bubbles, true);
    assert.equal(event.cancelable, true);
    assert.equal(event.composed, true);
    assert.equal(event.dataTransfer.getData("text/uri-list"), h.request().uriList);
    assert.equal(event.dataTransfer.effectAllowed, "copy");
    assert.equal(event.clientX, 60);
    assert.equal(event.clientY, 40);
    assert.deepEqual(plain(observation.geometry.treeRow), { tag: "BUTTON", testId: "code-workspace-tree-dir", rootId: "root2", rootPath: null, path: "incoming", treeKind: "dir" });
  }
  assert.equal(h.emissions.length, 0);
  assert.ok(h.mutations.every((m) => m.disconnected));
});

test("native enters/over/drop settle targeted Webview emit with physical coordinates and original paths", async () => {
  for (const phase of ["enter", "over", "drop"]) {
    const h = harness({ dpr: 1.75, label: "not-main" });
    const result = await h.run(h.request({ mode: "native", phase }));
    assert.equal(result.ok, true);
    const [target, event, payload] = h.emissions.at(-1);
    assert.deepEqual(plain(target), { kind: "Webview", label: "not-main" });
    assert.equal(event, `tauri://drag-${phase}`);
    assert.deepEqual(plain(payload), { paths: ["/中文 file.txt"], position: { x: 105, y: 70 } });
    assert.deepEqual(plain(result.statusMessages), ["Ready", "Importing 3 item(s)…"]);
    assert.equal(h.events.length, 0);
  }
});

test("native leave emits null, does not hit-test or require an old selector", async () => {
  const h = harness();
  h.document.querySelectorAll = () => { throw new Error("must not query stale leave selector"); };
  h.document.elementFromPoint = () => { throw new Error("must not hit-test leave"); };
  const result = await h.run(h.request({ mode: "native", phase: "leave", selector: "#removed", paths: [] }));
  assert.equal(result.ok, true);
  assert.deepEqual(plain(h.emissions), [[{ kind: "Webview", label: "actual-webview" }, "tauri://drag-leave", null]]);
  assert.equal(result.payload, null);
});

test("missing/ambiguous/hidden/offscreen/covered targets fail without delivering anything", async () => {
  for (const kind of ["missing", "ambiguous", "hidden", "offscreen", "covered"]) {
    const h = harness({ pointMode: kind === "covered" ? "occluded" : "child" });
    if (kind === "missing") h.setMatches([]);
    if (kind === "ambiguous") h.setMatches([h.element, h.element]);
    if (kind === "hidden") h.rect.width = 0;
    if (kind === "offscreen") Object.assign(h.rect, { top: 1000, bottom: 1040 });
    const result = await h.run(h.request());
    assert.equal(result.ok, false, kind);
    assert.equal(h.events.length, 0);
    assert.equal(h.emissions.length, 0);
  }
});

test("container blank targeting never quietly hits a file or directory row", async () => {
  const h = harness({ pointMode: "child" });
  h.attrs["data-testid"] = "code-workspace-tree";
  delete h.attrs["data-tree-kind"];
  const row = { ...h.child, closest: () => ({ getAttribute: () => "file" }) };
  h.document.elementFromPoint = () => row;
  let result = await h.run(h.request({ selector: "#tree" }));
  assert.equal(result.ok, false);
  assert.equal(h.events.length, 0);
  // The centre is occupied, but a real blank lower hit is available.
  h.document.elementFromPoint = (x, y) => y > 50 ? h.element : row;
  result = await h.run(h.request({ selector: "#tree" }));
  assert.equal(result.ok, true);
  assert.equal(result.geometry.treeRow, null);
  assert.equal(result.geometry.cssPosition.y, 56);
  assert.equal(h.events[0].target, h.element);
});

test("native API failures remain errors and retain payload; no fallback to DOM or IPC", async () => {
  const h = harness();
  h.tauri.event.emitTo = async () => { throw new Error("emit denied"); };
  const result = await h.run(h.request({ mode: "native" }));
  assert.equal(result.ok, false);
  assert.match(result.error, /emit denied/);
  assert.equal(result.eventName, "tauri://drag-drop");
  assert.ok(result.payload.paths.length);
  assert.equal(h.events.length, 0);
  assert.ok(h.mutations.every((m) => m.disconnected));
  h.window.__TAURI__ = undefined;
  const missing = await h.run(h.request({ mode: "native" }));
  assert.match(missing.error, /unavailable/);
});

test("hit point is clipped to the viewport and zero devicePixelRatio uses the documented fallback", async () => {
  const h = harness({ dpr: 0 });
  Object.assign(h.rect, { top: -20, bottom: 20, height: 40 });
  const result = await h.run(h.request({ mode: "native" }));
  assert.equal(result.ok, true);
  assert.equal(result.geometry.cssPosition.y, 10);
  assert.equal(result.payload.position.y, 10);
  assert.equal(result.geometry.devicePixelRatio, 1);
});
