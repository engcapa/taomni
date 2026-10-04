import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShellKeymapSettings } from "./ShellKeymapSettings";
import { registerShellKeyClaim } from "../../lib/shellKeyClaims";
import { useShellKeymapStore } from "../../lib/shell/shellKeymap";

beforeEach(() => useShellKeymapStore.getState().reset());
afterEach(cleanup);
function record(action = "shell.overview") {
  const row = document.querySelector(`[data-action-id="${action}"]`)!;
  fireEvent.click(row.querySelector("button")!);
  return screen.getByTestId("shell-keymap-capture");
}
describe("Shell shortcut settings", () => {
  it("compares a recorded Control binding with the effective Mod default", () => {
    render(<ShellKeymapSettings />);
    fireEvent.keyDown(record(), { key: "k", code: "KeyK", ctrlKey: true });
    expect(screen.getByTestId("shell-keymap-conflict")).toBeInTheDocument();
    expect(screen.getByTestId("shell-keymap-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("shell-keymap-cancel"));
    expect(useShellKeymapStore.getState().bindings["shell.overview"]).toBeUndefined();
  });
  it("shows the business scope for a first chord stroke even when its action is disabled", () => {
    const root = document.createElement("div");
    const dispose = registerShellKeyClaim(root, () => true, () => [{ scope: "Code · Project A", actionId: "workspace.reopen", title: "Reopen editor", stroke: { code: "KeyT", ctrl: true, alt: false, meta: false, shift: true } }]);
    try {
      render(<ShellKeymapSettings />);
      fireEvent.keyDown(record(), { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
      expect(screen.getByTestId("shell-keymap-conflict-scope")).toHaveTextContent("Code · Project A: Reopen editor");
      expect(screen.getByTestId("shell-keymap-save")).toBeDisabled();
    } finally { dispose(); }
  });
  it("persists an unclaimed binding, traps Tab and returns focus when cancelled", () => {
    render(<ShellKeymapSettings />);
    const capture = record();
    fireEvent.keyDown(capture, { key: "F9", code: "F9", ctrlKey: true, altKey: true });
    fireEvent.click(screen.getByTestId("shell-keymap-save"));
    expect(useShellKeymapStore.getState().bindings["shell.overview"]).toBe("Control+Alt+F9");
    const capture2 = record("shell.home");
    fireEvent.keyDown(capture2, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("shell-keymap-cancel"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement?.closest("[data-action-id]")?.getAttribute("data-action-id")).toBe("shell.home");
  });
});
