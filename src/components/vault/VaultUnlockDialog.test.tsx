import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultUnlockDialog } from "./VaultUnlockDialog";

afterEach(() => cleanup());

describe("VaultUnlockDialog", () => {
  it("submits the typed password via onSubmit", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <VaultUnlockDialog
        reason="Why you're being asked"
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByTestId("vault-unlock-reason")).toHaveTextContent(
      "Why you're being asked",
    );

    const input = screen.getByTestId("vault-unlock-pw");
    expect(input).toHaveFocus();
    await user.type(input, "the-master-password");
    await user.click(screen.getByTestId("vault-unlock-confirm"));
    expect(onSubmit).toHaveBeenCalledWith("the-master-password");
  });

  it("rewrites VAULT_BAD_PASSWORD error, marks the field invalid, and keeps focus for retry", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("VAULT_BAD_PASSWORD");
    });
    const user = userEvent.setup();
    render(<VaultUnlockDialog onCancel={() => undefined} onSubmit={onSubmit} />);

    const input = screen.getByTestId("vault-unlock-pw");
    await user.type(input, "wrong");
    await user.click(screen.getByTestId("vault-unlock-confirm"));

    const err = await screen.findByTestId("vault-unlock-error");
    expect(err).toHaveTextContent(/Incorrect master password/i);
    expect(err).toHaveAttribute("role", "alert");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/Incorrect master password/i);
    expect(input).toHaveFocus();
  });

  it("traps Tab navigation, ignores IME Escape/Enter, and restores focus on cancel", async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn(async () => undefined);
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const view = render(<VaultUnlockDialog onCancel={onCancel} onSubmit={onSubmit} />);
    const input = screen.getByTestId("vault-unlock-pw");
    const cancel = screen.getByTestId("vault-unlock-cancel");
    const confirm = screen.getByTestId("vault-unlock-confirm");

    expect(input).toHaveFocus();
    expect(confirm).toBeDisabled();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "secret" } });
    expect(confirm).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("can be made non-cancellable", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <VaultUnlockDialog
        cancellable={false}
        onCancel={onCancel}
        onSubmit={async () => undefined}
      />,
    );

    expect(screen.queryByTestId("vault-unlock-cancel")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId("vault-unlock-dialog")).toBeInTheDocument();
  });

  it("does not cancel when the modal backdrop is clicked", () => {
    const onCancel = vi.fn();
    render(<VaultUnlockDialog onCancel={onCancel} onSubmit={async () => undefined} />);

    const dialog = screen.getByTestId("vault-unlock-dialog");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 420, 240));
    const outside = { pointerId: 3, button: 0, clientX: 20, clientY: 20 };
    fireEvent.pointerDown(dialog, outside);
    fireEvent.pointerUp(dialog, outside);

    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });
});
