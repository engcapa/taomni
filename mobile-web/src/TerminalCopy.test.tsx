import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { TerminalCopy, terminalCopyText } from "./TerminalCopy";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("copies rendered Unicode without ANSI or artificial wraps and retains scrollback", async () => {
  const term = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  await new Promise<void>(resolve => term.write("\x1b[31mabcdefghijklm\x1b[0m\r\n中文\r\nlatest", resolve));
  expect(terminalCopyText({ buffer: term.buffer, getSelection: () => "" })).toBe("abcdefghijklm\n中文\nlatest");
  term.dispose();
});

it("preserves real spaces across wraps and omits wide-character padding", async () => {
  const term = new Terminal({ cols: 5, rows: 4, allowProposedApi: true });
  await new Promise<void>(resolve => term.write("abcd e\r\nabcd中文", resolve));
  expect(terminalCopyText({ buffer: term.buffer, getSelection: () => "" })).toBe("abcd e\nabcd中文");
  expect(terminalCopyText({ buffer: term.buffer, getSelection: () => "chosen 中文" })).toBe("chosen 中文");
  term.dispose();
});

it("writes only the selected portion to the clipboard, then closes and reports success", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const onClose = vi.fn(), onCopied = vi.fn();
  render(<TerminalCopy text={"first\n中文 second"} onClose={onClose} onCopied={onCopied} />);
  const field = screen.getByTestId("mobile-terminal-copy-text") as HTMLTextAreaElement;
  field.setSelectionRange(6, 8);
  fireEvent.select(field);
  expect(screen.getByTestId("mobile-terminal-copy-confirm")).toHaveTextContent("复制所选");
  await act(async () => fireEvent.click(screen.getByTestId("mobile-terminal-copy-confirm")));
  expect(writeText).toHaveBeenCalledWith("中文");
  expect(onCopied).toHaveBeenCalledWith("已复制所选内容。");
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps text selectable with an actionable fallback when the browser denies clipboard access", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  const onClose = vi.fn(), onCopied = vi.fn();
  render(<TerminalCopy text="available over HTTP" onClose={onClose} onCopied={onCopied} />);
  await act(async () => fireEvent.click(screen.getByTestId("mobile-terminal-copy-confirm")));
  expect(screen.getByTestId("mobile-terminal-copy-error")).toHaveTextContent("长按");
  expect(screen.getByTestId("mobile-terminal-copy-text")).toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();
  expect(onCopied).not.toHaveBeenCalled();
});
