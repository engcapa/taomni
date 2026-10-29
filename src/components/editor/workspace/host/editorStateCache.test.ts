import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { EditorStateCache } from "./editorStateCache";

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
