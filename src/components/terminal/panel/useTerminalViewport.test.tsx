import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useTerminalViewport, type UseTerminalViewportContext } from "./useTerminalViewport";

function context(): UseTerminalViewportContext {
  return {
    webglRendererRef: { current: false }, webglRenderer: false,
    termRef: { current: { options: {} } as Terminal },
    disposeTerminalWebgl: vi.fn(), installTerminalWebgl: vi.fn(),
    fontFamily: "monospace", fontSize: 13, resolvePanelTheme: () => ({}), themeName: "dark",
    cursorBlink: false, cursorStyle: "block", scrollback: 1000,
    fitVisibleTerminal: vi.fn(), visible: true, activeForShortcuts: true,
    searchOpen: false, focusTerminal: vi.fn(), fullscreen: false, showScrollbar: true,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("preserves keyboard tab navigation focus while measuring the newly active terminal", () => {
  const tablist = document.createElement("div");
  tablist.setAttribute("role", "tablist");
  tablist.dataset.keyboardNavigation = "true";
  const tab = document.createElement("button");
  tablist.append(tab);
  document.body.append(tablist);
  tab.focus();
  const state = context();
  const { rerender } = renderHook((value) => useTerminalViewport(value), { initialProps: state });
  act(() => vi.advanceTimersByTime(100));
  expect(state.fitVisibleTerminal).toHaveBeenCalled();
  expect(state.focusTerminal).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(tab);

  // A pointer tab switch clears the keyboard intent and focuses the terminal.
  rerender({ ...state, visible: false });
  delete tablist.dataset.keyboardNavigation;
  rerender(state);
  act(() => vi.advanceTimersByTime(100));
  expect(state.focusTerminal).toHaveBeenCalledTimes(1);
});

it("focuses ordinary terminal activation and keeps search focus intact", () => {
  const state = context();
  const { rerender } = renderHook((value) => useTerminalViewport(value), { initialProps: state });
  act(() => vi.advanceTimersByTime(100));
  expect(state.focusTerminal).toHaveBeenCalledTimes(1);
  rerender({ ...state, searchOpen: true });
  act(() => vi.advanceTimersByTime(100));
  expect(state.focusTerminal).toHaveBeenCalledTimes(1);
});

it("cancels a pending activation focus when the terminal becomes hidden", () => {
  const state = context();
  const { rerender } = renderHook((value) => useTerminalViewport(value), { initialProps: state });
  rerender({ ...state, visible: false });
  act(() => vi.advanceTimersByTime(100));
  expect(state.focusTerminal).not.toHaveBeenCalled();
});

it("keeps a path input that receives focus before delayed terminal activation", () => {
  const state = context();
  renderHook(() => useTerminalViewport(state));
  const path = document.createElement("input");
  document.body.append(path);
  path.focus();
  act(() => vi.advanceTimersByTime(100));
  expect(state.fitVisibleTerminal).toHaveBeenCalled();
  expect(state.focusTerminal).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(path);
});

it("remeasures layout changes without taking focus from another control", () => {
  const state = context();
  const { rerender } = renderHook((value) => useTerminalViewport(value), { initialProps: state });
  act(() => vi.advanceTimersByTime(100));
  expect(state.focusTerminal).toHaveBeenCalledTimes(1);
  const path = document.createElement("input");
  document.body.append(path);
  path.focus();
  rerender({ ...state, showScrollbar: false, fullscreen: true });
  act(() => vi.advanceTimersByTime(100));
  expect(state.focusTerminal).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(path);
});
