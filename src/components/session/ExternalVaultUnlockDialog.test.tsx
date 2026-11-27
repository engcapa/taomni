import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalVaultUnlockDialog } from "./ExternalVaultUnlockDialog";

afterEach(() => cleanup());

describe("ExternalVaultUnlockDialog", () => {
  it("focuses the password field, submits on Enter, and displays errors accessibly", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("Incorrect passphrase");
    });
    const user = userEvent.setup();
    render(
      <ExternalVaultUnlockDialog
        toolName="Tabby"
        description="Enter your encrypted Tabby vault password."
        onSubmit={onSubmit}
        onSkip={vi.fn()}
      />,
    );

    const input = screen.getByTestId("external-vault-unlock-pw");
    expect(input).toHaveFocus();
    await user.type(input, "bad-pass{Enter}");

    expect(onSubmit).toHaveBeenCalledWith("bad-pass");
    const err = await screen.findByTestId("external-vault-unlock-error");
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveTextContent("Incorrect passphrase");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Incorrect passphrase");
  });

  it("ignores IME Escape/Enter, traps Tab, does not dismiss on backdrop click, and returns focus on skip", () => {
    const onSkip = vi.fn();
    const onSubmit = vi.fn(async () => undefined);
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const view = render(
      <ExternalVaultUnlockDialog
        toolName="Tabby"
        description="Decrypt Tabby secrets"
        onSubmit={onSubmit}
        onSkip={onSkip}
      />,
    );

    const dialog = screen.getByTestId("external-vault-unlock-dialog");
    const input = screen.getByTestId("external-vault-unlock-pw");
    const skip = screen.getByTestId("external-vault-unlock-skip");

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(skip).toHaveFocus();
    fireEvent.keyDown(skip, { key: "Tab" });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "pw" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();

    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 420, 240));
    const outside = { pointerId: 4, button: 0, clientX: 10, clientY: 10 };
    fireEvent.pointerDown(dialog, outside);
    fireEvent.pointerUp(dialog, outside);
    expect(onSkip).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSkip).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
