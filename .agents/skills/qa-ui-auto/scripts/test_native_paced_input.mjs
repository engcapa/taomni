import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Run the scheduler embedded in the macOS QA binary. HTTP batching may only
// replace per-key requests if the bridge yields between the original key pairs.
const script = readFileSync(new URL("../../../../src-tauri/src/qa_driver_pointer.js", import.meta.url), "utf8");
const dispatch = new Function(`${script}\nreturn dispatchQaActions;`)();
const modifiers = () => ({ Control: false, Shift: false, Alt: false, Meta: false });
const source = (text) => [{ type: "key", actions: [...text].flatMap(value => [
  { type: "keyDown", value }, { type: "keyUp", value }, { type: "pause", duration: 20 },
]) }];

test("a batched request publishes each paced key before the next key arrives", async () => {
  let document = "";
  const observed = [];
  const edges = [];
  await dispatch(source("ab;"), (type, value) => {
    edges.push([type, value]);
    if (type === "keyDown") {
      document += value;
      queueMicrotask(() => observed.push(document));
    }
  }, modifiers(), () => [0, 0], () => assert.fail("keyboard input must not move the pointer"));
  assert.equal(document, "ab;");
  assert.deepEqual(observed, ["a", "ab", "ab;"]);
  assert.deepEqual(edges, [..."ab;"].flatMap(key => [["keyDown", key], ["keyUp", key]]));
});

test("a cancelled owner never delivers the rest of a paced batch", async () => {
  let cancelled = false;
  const keys = [];
  await dispatch(source("abc"), (type, value) => {
    if (type === "keyDown") {
      keys.push(value);
      queueMicrotask(() => { cancelled = true; });
    }
  }, modifiers(), () => [0, 0], () => null, () => cancelled);
  assert.deepEqual(keys, ["a"]);
});

for (const [modifier, raw] of [["Control", ""], ["Alt", ""], ["Meta", ""], ["Shift", ""]]) {
  test(`native drag-shaped synchronized sources retain ${modifier} through pointer-up`, async () => {
    const events = [];
    const target = {
      dispatchEvent: (event) => { events.push(event); return true; },
      closest: () => null,
    };
    class SyntheticEvent {
      constructor(type, init) { Object.assign(this, init, { type, defaultPrevented: false }); }
    }
    const dispatch = runInNewContext(`${script}\ndispatchQaActions`, {
      PointerEvent: SyntheticEvent,
      MouseEvent: SyntheticEvent,
      setTimeout,
    });
    const keys = modifiers();
    const pointer = [
      { type: "pointerMove", x: 100, y: 100 },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", x: 150, y: 120, duration: 1 },
      { type: "pointerUp", button: 0 },
    ];
    // This is the exact source/tick shape emitted by qa_ui_auto.native_drag.
    const sources = [
      { type: "pointer", id: "mouse", actions: [{ type: "pause" }, ...pointer, { type: "pause" }] },
      { type: "key", id: "drag-modifiers", actions: [
        { type: "keyDown", value: raw },
        ...pointer.map(() => ({ type: "pause" })),
        { type: "keyUp", value: raw },
      ] },
    ];
    await dispatch(sources, (type, value) => {
      assert.equal(value, raw);
      keys[modifier] = type === "keyDown";
    }, keys, (_origin, x, y) => [x, y], () => target);
    const actual = events.filter((event) => event.type.startsWith("pointer"));
    assert.deepEqual(actual.map((event) => event.type), ["pointermove", "pointerdown", "pointermove", "pointerup"]);
    const flag = { Control: "ctrlKey", Alt: "altKey", Meta: "metaKey", Shift: "shiftKey" }[modifier];
    assert.ok(actual.every((event) => event[flag]), `${flag} must remain set through pointer-up`);
    assert.equal(keys[modifier], false, "the final key-up releases the modifier");
    assert.equal(actual.at(-1).buttons, 0);
    assert.equal(actual[1].buttons, 1);
  });
}
