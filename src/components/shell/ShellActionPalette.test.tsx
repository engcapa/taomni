import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellActionPalette } from "./ShellActionPalette";
import { useShellShortcuts } from "../../hooks/useShellShortcuts";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useAppStore } from "../../stores/appStore";
import { defaultShellLayout } from "../../lib/shell/shellLayoutPersistence";

function Harness() { useShellShortcuts(); return <><textarea aria-label="Editor" defaultValue="draft 中文" /><ShellActionPalette /></>; }
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView ??= () => {};
  useAppStore.setState({ tabs: [{ id: "welcome", type: "welcome", title: "Home", closable: false }], activeTabId: "welcome" });
  useShellLayoutStore.setState({ layout: defaultShellLayout(), immersive: false, immersiveReveal: null, overlay: null, laneSelection: null, panels: {} });
});
afterEach(cleanup);

it("leaves Escape to temporary titlebar and nested menus even when a navigator overlay is retained", () => {
  useShellLayoutStore.setState({ immersive: true, immersiveReveal: "toolbar", navigatorOverlay: true });
  render(<Harness />);
  const bubble = vi.fn((event: KeyboardEvent) => { expect(event.defaultPrevented).toBe(false); });
  document.addEventListener("keydown", bubble);
  fireEvent.keyDown(document.body, { key: "Escape" });
  document.removeEventListener("keydown", bubble);
  expect(bubble).toHaveBeenCalledOnce();
  expect(useShellLayoutStore.getState().navigatorOverlay).toBe(true);
});

it("opens from an editor, enters immersive mode and always offers an exit without replacing its draft", () => {
  render(<Harness />);
  const editor = screen.getByLabelText("Editor"); editor.focus();
  fireEvent.keyDown(editor, { key: "F1" });
  const input = screen.getByTestId("shell-action-search");
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "shell.immersive.toggle" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useShellLayoutStore.getState().immersive).toBe(true);
  expect(screen.queryByTestId("shell-action-palette")).toBeNull();
  fireEvent.keyDown(editor, { key: "P", ctrlKey: true, shiftKey: true });
  fireEvent.change(screen.getByTestId("shell-action-search"), { target: { value: "shell.immersive.toggle" } });
  fireEvent.keyDown(screen.getByTestId("shell-action-search"), { key: "Enter" });
  expect(useShellLayoutStore.getState().immersive).toBe(false);
  expect(screen.getByLabelText("Editor")).toBe(editor);
  expect(editor).toHaveValue("draft 中文");
});

it("does not run disabled commands, composing Enter, or cancelled search", () => {
  const run = vi.fn();
  render(<ShellActionPalette commands={[{ id: "test.run", title: "Run command", run }, { id: "test.disabled", title: "Disabled", disabledReason: "Connect first", run }]} />);
  act(() => useShellLayoutStore.getState().setOverlay("actions"));
  const input = screen.getByTestId("shell-action-search");
  fireEvent.change(input, { target: { value: "test.disabled" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("Connect first")).toBeVisible();
  fireEvent.change(input, { target: { value: "test.run" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(run).not.toHaveBeenCalled();
  expect(screen.queryByTestId("shell-action-palette")).toBeNull();
});

it("changes dock position and visibility independently of immersive mode", () => {
  render(<Harness />);
  const choose = (id: string) => {
    fireEvent.keyDown(window, { key: "F1" });
    fireEvent.change(screen.getByTestId("shell-action-search"), { target: { value: id } });
    fireEvent.keyDown(screen.getByTestId("shell-action-search"), { key: "Enter" });
  };
  choose("shell.rail.bottom");
  choose("shell.rail.toggle");
  expect(useShellLayoutStore.getState().layout.rail).toEqual({ edge: "bottom", visible: false });
  choose("shell.immersive.toggle"); choose("shell.immersive.toggle");
  expect(useShellLayoutStore.getState().layout.rail).toEqual({ edge: "bottom", visible: false });
  choose("shell.rail.toggle");
  expect(useShellLayoutStore.getState().layout.rail.visible).toBe(true);
});


it("keeps command failures visible and permits another command", async () => {
  render(<ShellActionPalette commands={[{ id: "test.failure", title: "Failure", run: async () => { throw new Error("Backend unavailable"); } }]} />);
  act(() => useShellLayoutStore.getState().setOverlay("actions"));
  fireEvent.change(screen.getByTestId("shell-action-search"), { target: { value: "test.failure" } });
  await act(async () => fireEvent.keyDown(screen.getByTestId("shell-action-search"), { key: "Enter" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Backend unavailable");
  fireEvent.change(screen.getByTestId("shell-action-search"), { target: { value: "shell.rail.top" } });
  fireEvent.keyDown(screen.getByTestId("shell-action-search"), { key: "Enter" });
  expect(useShellLayoutStore.getState().layout.rail.edge).toBe("top");
});
