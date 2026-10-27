import type { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { getTerminalPreviewText } from "./buffer";

function terminal(rows: string[], baseY = 0, wrappedRow = -1) {
  const getLine = vi.fn((index: number) => ({
    isWrapped: index === wrappedRow,
    translateToString: () => rows[index] ?? "",
  }));
  const value = { buffer: { active: { length: rows.length, baseY, getLine } } } as unknown as Terminal;
  return { value, getLine };
}

it("previews short terminal output above unused screen rows", () => {
  const { value } = terminal(["$ echo ready", "ready", "$ ", ...Array<string>(45).fill("")]);
  expect(getTerminalPreviewText(value, 8)).toBe("$ echo ready\nready\n$ ");
});

it("keeps wrapped and internal blank lines in the recent populated tail", () => {
  const { value } = terminal(["old", "first", "continuation", "", "$ ", "", ""], 0, 2);
  expect(getTerminalPreviewText(value, 4)).toBe("firstcontinuation\n\n$ ");
});

it("bounds blank-screen reads to the viewport instead of scanning scrollback", () => {
  const { value, getLine } = terminal([...Array<string>(10000).fill("history"), ...Array<string>(40).fill("")], 10000);
  expect(getTerminalPreviewText(value, 8)).toBe(Array<string>(8).fill("history").join("\n"));
  expect(getLine.mock.calls.length).toBeLessThanOrEqual(48);
});
