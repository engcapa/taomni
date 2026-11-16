import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../../../../src-tauri/src/qa_driver_pointer.js", import.meta.url), "utf8");
class InputEvent {
  constructor(type, init) { Object.assign(this, init, { type, defaultPrevented: false }); }
  preventDefault() { this.defaultPrevented = true; }
}
const dispatch = runInNewContext(`${script}\ndispatchQaActions`, {
  PointerEvent: InputEvent, MouseEvent: InputEvent, setTimeout,
});
class CapturingElement {
  setPointerCapture() { throw new Error("the synthetic pointer has no native capture"); }
  hasPointerCapture() { return false; }
  releasePointerCapture() { throw new Error("unexpected native release"); }
}
const dispatchCaptured = runInNewContext(`${script}\ndispatchQaActions`, {
  Element: CapturingElement, PointerEvent: InputEvent, MouseEvent: InputEvent, setTimeout,
});
function element(parentElement = null, handler = () => {}) {
  return {
    parentElement, isConnected: true, events: [], focused: false,
    contains(other) {
      for (let current = other; current; current = current.parentElement) if (current === this) return true;
      return false;
    },
    closest() { return this; },
    matches() { return false; },
    focus() { this.focused = true; },
    dispatchEvent(event) { this.events.push(event); handler(event, this); return !event.defaultPrevented; },
  };
}
function click(targetAtPoint, count = 1) {
  return dispatch([{ type: "pointer", actions: [
    { type: "pointerMove", x: 100, y: 100 },
    ...Array.from({ length: count }, () => [
      { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 },
    ]).flat(),
  ] }], () => {}, { Control: false, Shift: false, Alt: false, Meta: false }, (_origin, x, y) => [x, y], targetAtPoint);
}
const types = (target) => target.events.map((event) => event.type);

test("one pointer activation cannot toggle a replacement Markdown checkbox twice", async () => {
  let changes = 0;
  const replacement = element(null, (event) => { if (event.type === "click") changes++; });
  let current;
  const original = element(null, (event, target) => {
    if (event.type === "mousedown") {
      changes++;
      event.preventDefault();
      target.isConnected = false;
      current = replacement;
    }
  });
  current = original;
  await click(() => current);
  assert.equal(changes, 1);
  assert.equal(original.focused, false, "cancelled mousedown must keep editor focus");
  assert.deepEqual(types(replacement), ["pointerup", "mouseup"]);
});

test("a retained control receives one click and the existing double-click sequence", async () => {
  const target = element();
  // An ordinary control has no inert ancestor.
  target.closest = (selector) => selector === "[inert]" ? null : target;
  await click(() => target, 2);
  assert.equal(target.focused, true);
  assert.equal(types(target).filter((type) => type === "click").length, 2);
  assert.equal(types(target).filter((type) => type === "dblclick").length, 1);
});

test("connected sibling down/up targets activate the common parent", async () => {
  const parent = element();
  const up = element(parent);
  let current;
  const down = element(parent, (event) => { if (event.type === "mousedown") current = up; });
  current = down;
  await click(() => current);
  assert.deepEqual(types(parent), ["click"]);
  assert.equal(types(up).includes("click"), false);
});

test("removal during mouseup cannot activate a detached control", async () => {
  const target = element(null, (event, node) => { if (event.type === "mouseup") node.isConnected = false; });
  await click(() => target);
  assert.equal(types(target).includes("click"), false);
});

test("prevented pointerdown suppresses compatibility mouse events and retains click", async () => {
  const target = element(null, (event) => { if (event.type === "pointerdown") event.preventDefault(); });
  await click(() => target);
  assert.deepEqual(types(target).filter((type) => type !== "mouseover" && type !== "mousemove"),
    ["pointermove", "pointerdown", "pointerup", "click"]);
  assert.equal(target.focused, false);
});

const dragActions = [{ type: "pointer", actions: [
  { type: "pointerMove", x: 100, y: 100 },
  { type: "pointerDown", button: 0 },
  { type: "pointerMove", x: 160, y: 100 },
  { type: "pointerUp", button: 0 },
] }];
function capturing(handler) {
  return Object.setPrototypeOf(element(null, handler), CapturingElement.prototype);
}
const modifiers = { Control: false, Shift: false, Alt: false, Meta: false };
const origin = (_origin, x, y) => [x, y];

test("a captured Markdown separator keeps receiving moves outside its hit rectangle", async () => {
  const original = Object.getOwnPropertyDescriptors(CapturingElement.prototype);
  let ratio = 50;
  let capturedOnUp = false;
  const preview = element();
  const handle = capturing((event, node) => {
    if (event.type === "pointerdown") { node.setPointerCapture(event.pointerId); event.preventDefault(); }
    if (event.type === "pointermove" && event.buttons === 1) ratio = event.clientX;
    if (event.type === "pointerup") {
      capturedOnUp = node.hasPointerCapture(event.pointerId);
      node.releasePointerCapture(event.pointerId);
    }
  });
  await dispatchCaptured(dragActions, () => {}, modifiers, origin, x => x === 100 ? handle : preview);
  assert.equal(ratio, 160, "the actual separator handler must observe the moved pointer");
  assert.equal(capturedOnUp, true);
  assert.equal(types(preview).includes("pointermove"), false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(CapturingElement.prototype), original);
});

test("capture APIs are restored after a cancelled drag", async () => {
  const original = Object.getOwnPropertyDescriptors(CapturingElement.prototype);
  const handle = capturing((event, node) => {
    if (event.type === "pointerdown") node.setPointerCapture(event.pointerId);
  });
  let ticks = 0;
  await dispatchCaptured(dragActions, () => {}, modifiers, origin, () => handle, () => ++ticks > 2);
  assert.deepEqual(Object.getOwnPropertyDescriptors(CapturingElement.prototype), original);
  assert.equal(types(handle).includes("pointerup"), false);
});

test("a throwing application handler releases capture and restores native methods", async () => {
  const original = Object.getOwnPropertyDescriptors(CapturingElement.prototype);
  const handle = capturing((event, node) => {
    if (event.type === "pointerdown") node.setPointerCapture(event.pointerId);
    if (event.type === "pointermove" && event.buttons) throw new Error("application failure");
  });
  await assert.rejects(dispatchCaptured(dragActions, () => {}, modifiers, origin, () => handle), /application failure/);
  assert.deepEqual(Object.getOwnPropertyDescriptors(CapturingElement.prototype), original);
});
