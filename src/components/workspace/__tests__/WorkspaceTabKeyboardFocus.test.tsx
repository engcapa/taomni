import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { WorkspaceTabStrip } from "../WorkspaceTabStrip";
import { useTerminalViewport, type UseTerminalViewportContext } from "../../terminal/panel/useTerminalViewport";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";

// Keep the real activation owner. Only xterm's DOM focus/fit boundary is a
// fixture, so its delayed effect can race the actual workspace tab navigation.
function TerminalViewport({ id }: { id: string }) {
  const active = useWorkspacePlatformStore((state) => state.workspaces[0].activeTabId === id);
  const context = useMemo<UseTerminalViewportContext>(() => ({
    webglRendererRef: { current: false }, webglRenderer: false,
    termRef: { current: { options: {} } as Terminal },
    disposeTerminalWebgl: vi.fn(), installTerminalWebgl: vi.fn(),
    fontFamily: "monospace", fontSize: 13, resolvePanelTheme: () => ({}), themeName: "dark",
    cursorBlink: false, cursorStyle: "block", scrollback: 1000,
    fitVisibleTerminal: vi.fn(), visible: true, activeForShortcuts: true,
    searchOpen: false, focusTerminal: () => screen.getByTestId(`terminal-${id}`).focus(),
    fullscreen: false, showScrollbar: true,
  }), [id]);
  useTerminalViewport({ ...context, visible: active, activeForShortcuts: active });
  return <textarea data-testid={`terminal-${id}`} hidden={!active} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspaceUiStore.setState({ tabFilters: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function mountNavigation() {
  const store = useWorkspacePlatformStore.getState();
  const tabs = Array.from({ length: 3 }, () => store.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID));
  render(<><WorkspaceTabStrip />{tabs.map((tab) => <TerminalViewport key={tab.id} id={tab.id} />)}</>);
  act(() => vi.advanceTimersByTime(100));
  return { tabs, buttons: screen.getAllByTestId("workspace-tab"), strip: screen.getByTestId("workspace-tab-scroll-area") };
}

it("retains tab focus through delayed terminal activation during Home, End and arrow navigation", () => {
  const { buttons } = mountNavigation();
  fireEvent.keyDown(buttons[2], { key: "Home" });
  expect(buttons[0]).toHaveFocus();
  act(() => vi.advanceTimersByTime(100));
  expect(buttons[0]).toHaveFocus();
  fireEvent.keyDown(buttons[0], { key: "End" });
  act(() => vi.advanceTimersByTime(100));
  expect(buttons[2]).toHaveFocus();
  expect(buttons[2]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(buttons[2], { key: "ArrowRight" });
  act(() => vi.advanceTimersByTime(100));
  expect(buttons[0]).toHaveFocus();
  expect(buttons[0]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(buttons[0], { key: "ArrowLeft" });
  act(() => vi.advanceTimersByTime(100));
  expect(buttons[2]).toHaveFocus();
});

it("returns automatic terminal focus to pointer activation after keyboard navigation", () => {
  const { tabs, buttons } = mountNavigation();
  fireEvent.keyDown(buttons[2], { key: "Home" });
  act(() => vi.advanceTimersByTime(100));
  expect(buttons[0]).toHaveFocus();
  fireEvent.pointerDown(buttons[1]);
  fireEvent.click(buttons[1]);
  act(() => vi.advanceTimersByTime(100));
  expect(screen.getByTestId(`terminal-${tabs[1].id}`)).toHaveFocus();
  expect(buttons[1]).toHaveAttribute("aria-selected", "true");
});
