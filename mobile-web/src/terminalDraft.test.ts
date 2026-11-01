import { expect, it } from "vitest";
import { editDraft } from "./terminalDraft";

it("edits the focused draft at its selection instead of injecting symbols into the PTY", () => {
  expect(editDraft("echo ab", 6, 6, "|")).toEqual({ value: "echo a|b", start: 7, end: 7 });
  expect(editDraft("echo 中文", 5, 7, "~")).toEqual({ value: "echo ~", start: 6, end: 6 });
  expect(editDraft("a😀b", 3, 3, "\x7f")).toEqual({ value: "ab", start: 1, end: 1 });
  expect(editDraft("a😀b", 3, 3, "\x1b[D")?.start).toBe(1);
  expect(editDraft("a😀b", 1, 1, "\x1b[C")?.start).toBe(3);
});

it("handles line and word editing while other terminal controls stay remote", () => {
  expect(editDraft("one two", 7, 7, "\x17")).toEqual({ value: "one ", start: 4, end: 4 });
  expect(editDraft("one two", 7, 7, "\x1b[1;5D")?.start).toBe(4);
  expect(editDraft("a\nline text", 7, 7, "\x01")?.start).toBe(2);
  expect(editDraft("a\nline text", 7, 7, "\x0b")).toEqual({ value: "a\nline ", start: 7, end: 7 });
  expect(editDraft("one", 3, 3, "\x03")).toBeNull();
  expect(editDraft("one", 3, 3, "\x1b[A")).toBeNull();
});
