import { Compartment, EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { EditorStateCache, reconfigureCachedEditorState } from "./editorStateCache";
import { readOnlyExtension } from "./appearance";

const entry = (path: string, text: string) => ({ state: EditorState.create({ doc: text }), path, scrollTop: 20, scrollLeft: 8 });

it("bounds cached documents by LRU order and total retained characters", () => {
  const cache = new EditorStateCache(2, 6);
  cache.save("a", entry("a.txt", "aaa"));
  cache.save("b", entry("b.txt", "bb"));
  const a = cache.take("a", "a.txt")!;
  cache.save("a", a);
  cache.save("c", entry("c.txt", "c"));
  expect(cache.take("b", "b.txt")).toBeUndefined();
  expect(cache.take("a", "a.txt")).toBe(a);
  cache.save("d", entry("d.txt", "dddddd"));
  expect(cache.take("c", "c.txt")).toBeUndefined();
  cache.save("oversized", entry("large.txt", "1234567"));
  expect(cache.take("oversized", "large.txt")).toBeUndefined();
  expect(cache.take("d", "d.txt")?.state.doc.toString()).toBe("dddddd");
});

it("forgets closed, renamed and disposed documents without retaining their states", () => {
  const cache = new EditorStateCache();
  cache.save("a", entry("a.txt", "draft"));
  cache.save("b", entry("b.txt", "other"));
  cache.retain(["b"]);
  expect(cache.take("a", "a.txt")).toBeUndefined();
  expect(cache.take("b", "renamed.txt")).toBeUndefined();
  expect(cache.take("b", "b.txt")).toBeUndefined();
  cache.save("c", entry("c.txt", "last"));
  cache.clear();
  expect(cache.take("c", "c.txt")).toBeUndefined();
});

it("replaces cached compartment overrides with the current settings", () => {
  const settings = new Compartment();
  const initial = EditorState.create({ doc: "cached", extensions: settings.of(EditorState.tabSize.of(2)) });
  const cached = initial.update({ effects: settings.reconfigure(EditorState.tabSize.of(4)) }).state;
  const current = EditorState.tabSize.of(8);
  const restored = reconfigureCachedEditorState(cached, "cached", settings.of(current), [settings.reconfigure(current)]);
  expect(restored.tabSize).toBe(8);
});

it("reconciles canonical disk content even when the cached document was read-only", () => {
  const cached = EditorState.create({ doc: "old disk snapshot", extensions: readOnlyExtension(true) });
  const restored = reconfigureCachedEditorState(cached, "new disk content", readOnlyExtension(false));
  expect(restored.doc.toString()).toBe("new disk content");
  expect(restored.readOnly).toBe(false);
});
