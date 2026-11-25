import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultSetupDialog } from "./VaultSetupDialog";

afterEach(() => cleanup());

describe("VaultSetupDialog", () => {
  it("disables submit until passwords match and meet length", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<VaultSetupDialog onCancel={() => undefined} onSubmit={onSubmit} />);

    const submit = screen.getByTestId("vault-setup-confirm");
    expect(submit).toBeDisabled();

    await user.type(screen.getByTestId("vault-setup-pw1"), "short");
    expect(screen.getByTestId("vault-setup-too-short")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.clear(screen.getByTestId("vault-setup-pw1"));
    await user.type(screen.getByTestId("vault-setup-pw1"), "long-enough-pw");
    await user.type(screen.getByTestId("vault-setup-pw2"), "different-pw");
    expect(screen.getByTestId("vault-setup-mismatch")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.clear(screen.getByTestId("vault-setup-pw2"));
    await user.type(screen.getByTestId("vault-setup-pw2"), "long-enough-pw");
    expect(submit).not.toBeDisabled();

    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith("long-enough-pw");
  });

  it("surfaces backend errors from onSubmit", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("boom");
    });
    const user = userEvent.setup();
    render(<VaultSetupDialog onCancel={() => undefined} onSubmit={onSubmit} />);

    await user.type(screen.getByTestId("vault-setup-pw1"), "long-enough-pw");
    await user.type(screen.getByTestId("vault-setup-pw2"), "long-enough-pw");
    await user.click(screen.getByTestId("vault-setup-confirm"));

    expect(await screen.findByTestId("vault-setup-error")).toHaveTextContent("boom");
  });

  it("associates validation with the first password and keeps a cancelled discard editable", async () => {
    const cancel = vi.fn();
    const user = userEvent.setup();
    render(<VaultSetupDialog onCancel={cancel} onSubmit={vi.fn()} />);
    const input = screen.getByTestId("vault-setup-pw1");
    expect(input).toHaveAccessibleName();
    expect(input).toHaveFocus();
    await user.type(input, "short");
    expect(input).toHaveAccessibleDescription(screen.getByTestId("vault-setup-too-short").textContent!);
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("confirm-dialog-cancel")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(input).toHaveValue("short");
    expect(cancel).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("vault-setup-cancel"));
    await user.click(screen.getByTestId("confirm-dialog-confirm"));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps one initialization in flight and preserves both inputs on error for retry", async () => {
    let reject!: (reason: Error) => void;
    const submit = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const cancel = vi.fn();
    const user = userEvent.setup();
    render(<VaultSetupDialog onCancel={cancel} onSubmit={submit} />);
    const password = screen.getByTestId("vault-setup-pw1");
    const confirm = screen.getByTestId("vault-setup-pw2");
    const button = screen.getByTestId("vault-setup-confirm");
    await user.type(password, "my-long-password");
    await user.type(confirm, "my-long-password{Enter}");
    fireEvent.submit(confirm.closest("form")!);
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(submit).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(password).toHaveAttribute("readonly");
    expect(button).toHaveAttribute("aria-busy", "true");
    await act(async () => reject(new Error("Storage unavailable")));
    expect(screen.getByRole("alert")).toHaveTextContent("Storage unavailable");
    expect(password).toHaveValue("my-long-password");
    expect(confirm).toHaveValue("my-long-password");
    expect(button).toBeEnabled();
  });

  it("cancels via Escape", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<VaultSetupDialog onCancel={onCancel} onSubmit={async () => undefined} />);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });
});
