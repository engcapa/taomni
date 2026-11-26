import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_PROFILE } from "../../../lib/terminalProfile";
import { CurrentTerminalSettingsDialog } from "./CurrentTerminalSettingsDialog";

vi.mock("../TerminalAppearanceSettings", () => ({
  TerminalAppearanceSettings: () => (
    <div data-testid="terminal-appearance-settings">
      <input aria-label="Terminal font size" defaultValue="14" />
    </div>
  ),
}));

afterEach(() => cleanup());

describe("CurrentTerminalSettingsDialog", () => {
  it("renders in the modal top layer, traps Tab navigation, guards IME Escape, and returns focus on close", () => {
    const onClose = vi.fn();
    const onSaveAsDefault = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const view = render(
      <CurrentTerminalSettingsDialog
        profile={{ ...DEFAULT_TERMINAL_PROFILE }}
        onProfileChange={vi.fn()}
        onSaveAsDefault={onSaveAsDefault}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByTestId("terminal-current-settings-dialog");
    expect(dialog).toHaveAttribute("data-size", "complex");
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const footerClose = screen.getByTestId("terminal-current-settings-footer-close");
    const headerClose = dialog.querySelector("header button") as HTMLButtonElement;
    expect(footerClose).toHaveFocus();

    fireEvent.keyDown(footerClose, { key: "Tab" });
    expect(headerClose).toHaveFocus();
    fireEvent.keyDown(headerClose, { key: "Tab", shiftKey: true });
    expect(footerClose).toHaveFocus();

    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(80, 80, 960, 600));
    const outside = { pointerId: 5, button: 0, clientX: 10, clientY: 10 };
    fireEvent.pointerDown(dialog, outside);
    fireEvent.pointerUp(dialog, outside);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("terminal-current-settings-save-default"));
    expect(onSaveAsDefault).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(footerClose, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(footerClose, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
