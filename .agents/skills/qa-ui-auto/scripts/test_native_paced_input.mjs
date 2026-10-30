import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
