import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Frame } from "./live";

const mock = vi.hoisted(() => ({ frame: (_frame: Frame) => {}, status: (_status: string) => {}, send: vi.fn(() => true), input: (_data: string) => {}, resize: (_size: unknown) => {}, term: null as any }));
vi.mock("./live", () => ({ useLive: (_instance: unknown, _path: string, frame: (frame: Frame) => void, status: (value: string) => void) => { mock.frame = frame; mock.status = status; return { send: mock.send, canRetry: false, retry: vi.fn() }; } }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 40; rows = 20; textarea: HTMLTextAreaElement | undefined;
  options: Record<string, unknown>;
  modes = { bracketedPasteMode: false, applicationCursorKeysMode: false };
  buffer = { active: { viewportY: 0, baseY: 0 } };
  constructor(options: Record<string, unknown>) { this.options = options; mock.term = this; }
  loadAddon() {}
  open(host: HTMLElement) { this.textarea = document.createElement("textarea"); this.textarea.className = "xterm-helper-textarea"; host.appendChild(this.textarea); }
  onData(callback: (data: string) => void) { mock.input = callback; return { dispose() {} }; }
  onResize(callback: (size: unknown) => void) { mock.resize = callback; return { dispose() {} }; }
  onScroll() { return { dispose() {} }; }
  onWriteParsed() { return { dispose() {} }; }
  write() {} reset() {} scrollToBottom() {} dispose() {}
  focus() { this.textarea?.focus(); } blur() { this.textarea?.blur(); }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

import { TerminalView } from "./TerminalView";
const instance = { id: "pc", deviceId: "phone", label: "PC", endpoint: "https://pc.example", token: "t" };
const session = { id: "term:t", kind: "terminal" as const, title: "Shell", status: "running", summary: "" };
beforeEach(() => {
  localStorage.clear(); mock.send.mockClear(); mock.send.mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function connect() {
  act(() => { mock.status("已连接"); mock.frame({ type: "hello", connection_id: "c" }); mock.frame({ type: "control", holder: "mobile:phone", connection_id: "c" }); });
}
const inputs = () => mock.send.mock.calls.map((call: unknown[]) => call[0] as Frame).filter(frame => frame.type === "input").map(frame => new TextDecoder().decode(Uint8Array.from(atob(String(frame.data_b64)), c => c.charCodeAt(0))));

it("keeps read-only input out of the wire, then adopts and follows phone geometry only while holder", () => {
  vi.useFakeTimers();
  render(<TerminalView instance={instance} session={session} />);
  act(() => mock.input("x"));
  expect(inputs()).toEqual([]);
  expect(screen.getByTestId("mobile-terminal-notice")).toHaveTextContent("只读");
  connect();
  act(() => { vi.advanceTimersByTime(60); });
  expect(mock.send).toHaveBeenCalledWith({ type: "resize", cols: 40, rows: 20 });
  mock.send.mockClear();
  act(() => { mock.term.cols = 50; mock.resize({ cols: 50, rows: 20 }); vi.advanceTimersByTime(150); });
  expect(mock.send).toHaveBeenCalledWith({ type: "resize", cols: 50, rows: 20 });
  act(() => mock.frame({ type: "control-lost" }));
  mock.send.mockClear();
  act(() => { mock.resize({}); mock.input("x"); vi.advanceTimersByTime(150); });
  expect(mock.send).not.toHaveBeenCalled();
});

it("warns before takeover and exposes desktop activity without opening the more menu", () => {
  render(<TerminalView instance={instance} session={session} />);
  act(() => { mock.status("已连接"); mock.frame({ type: "control", holder: "none", desktop_last_activity_at: 1700000000 }); });
  expect(screen.getByTestId("mobile-control-warning")).toHaveTextContent("输入可能打断正在执行的命令");
  expect(screen.getByTestId("mobile-control-warning")).toHaveTextContent("桌面最近活动：");
  expect(screen.getByTestId("mobile-take-control")).toHaveAttribute("aria-describedby", "mobile-control-warning");
  expect(screen.queryByTestId("mobile-terminal-menu")).toBeNull();
  fireEvent.click(screen.getByTestId("mobile-take-control"));
  expect(mock.send).toHaveBeenCalledWith({ type: "take-control" });
  connect();
  expect(screen.queryByTestId("mobile-control-warning")).toBeNull();
  fireEvent.click(screen.getByTestId("mobile-take-control"));
  expect(mock.send).toHaveBeenCalledWith({ type: "release-control" });
});

it("applies sticky Ctrl to the next system-keyboard character and resets on lost control", () => {
  render(<TerminalView instance={instance} session={session} />);
  connect();
  fireEvent.click(screen.getByTestId("mobile-key-ctrl"));
  act(() => mock.input("r"));
  act(() => mock.input("x"));
  expect(inputs()).toEqual(["\x12", "x"]);
  fireEvent.click(screen.getByTestId("mobile-key-alt"));
  act(() => mock.frame({ type: "control-lost" }));
  expect(screen.getByTestId("mobile-key-alt")).toHaveAttribute("aria-pressed", "false");
});

it("edits focused command drafts with symbol/arrow keys and brackets paste exactly once", () => {
  render(<TerminalView instance={instance} session={session} />);
  connect();
  fireEvent.click(screen.getByTestId("mobile-terminal-keyboard"));
  const command = screen.getByTestId("mobile-terminal-command") as HTMLInputElement;
  fireEvent.change(command, { target: { value: "ab" } });
  command.focus(); command.setSelectionRange(1, 1);
  fireEvent.click(screen.getByTestId("mobile-key-pipe"));
  expect(command).toHaveValue("a|b");
  expect(inputs()).toEqual([]);
  mock.term.modes.bracketedPasteMode = true;
  fireEvent.submit(command.closest("form")!);
  expect(inputs()).toEqual(["\x1b[200~a|b\x1b[201~\r"]);
  expect(command).toHaveValue("");
});

it("defaults to a compact keyboard, preserves a system draft across switches and stops typing when control is lost", () => {
  render(<TerminalView instance={instance} session={session} />);
  expect(screen.getByTestId("mobile-terminal-command")).not.toBeVisible();
  expect(screen.queryByTestId("mobile-terminal-menu")).toBeNull();
  connect();
  fireEvent.click(screen.getByTestId("mobile-type-a"));
  fireEvent.click(screen.getByTestId("mobile-key-ctrl"));
  fireEvent.click(screen.getByTestId("mobile-type-c"));
  fireEvent.click(screen.getByTestId("mobile-type-enter"));
  expect(inputs()).toEqual(["a", "\x03", "\r"]);
  expect(mock.term.textarea.inputMode).toBe("none");
  fireEvent.click(screen.getByTestId("mobile-terminal-keyboard"));
  const command = screen.getByTestId("mobile-terminal-command");
  expect(command).toHaveFocus();
  fireEvent.change(command, { target: { value: "echo 中文" } });
  fireEvent.click(screen.getByTestId("mobile-input-compact"));
  expect(command).not.toHaveFocus();
  expect(command).not.toBeVisible();
  fireEvent.click(screen.getByTestId("mobile-terminal-keyboard"));
  expect(command).toHaveValue("echo 中文");
  act(() => mock.frame({ type: "control-lost" }));
  expect(command).toBeDisabled();
  expect(screen.queryByTestId("mobile-compact-keyboard")).toBeNull();
});

it("keeps font, resize, fullscreen and history available through more and dismisses it with Escape", () => {
  render(<TerminalView instance={instance} session={session} />);
  connect();
  fireEvent.click(screen.getByTestId("mobile-terminal-more"));
  fireEvent.click(screen.getByTestId("mobile-terminal-font-up"));
  expect(mock.term.options.fontSize).toBe(14);
  fireEvent.click(screen.getByTestId("mobile-resize"));
  expect(mock.send).toHaveBeenCalledWith({ type: "resize", cols: 40, rows: 20 });
  expect(screen.queryByTestId("mobile-terminal-menu")).toBeNull();
  fireEvent.click(screen.getByTestId("mobile-terminal-more"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByTestId("mobile-terminal-menu")).toBeNull();
  expect(screen.getByTestId("mobile-terminal-more")).toHaveFocus();
});

it("direct system input sends incrementally before Tab and never adds an implicit Enter", () => {
  render(<TerminalView instance={instance} session={session} />);
  connect();
  fireEvent.click(screen.getByTestId("mobile-input-direct"));
  expect(mock.term.textarea).toHaveFocus();
  expect(mock.term.textarea.inputMode).toBe("text");
  act(() => mock.input("git che"));
  fireEvent.click(screen.getByTestId("mobile-key-tab"));
  act(() => mock.input("中文"));
  expect(inputs()).toEqual(["git che", "\t", "中文"]);
  fireEvent.click(screen.getByTestId("mobile-input-compact"));
  expect(mock.term.textarea.inputMode).toBe("none");
  expect(mock.term.textarea).not.toHaveFocus();
  act(() => mock.frame({ type: "control-lost" }));
  act(() => mock.input("late"));
  expect(inputs()).toEqual(["git che", "\t", "中文"]);
});
