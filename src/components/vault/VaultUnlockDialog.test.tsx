import { cleanup, render, screen } from "@testing-library/react";
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
    await user.type(input, "the-master-password");
    await user.click(screen.getByTestId("vault-unlock-confirm"));
    expect(onSubmit).toHaveBeenCalledWith("the-master-password");
  });

  it("rewrites VAULT_BAD_PASSWORD error to a friendlier message", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("VAULT_BAD_PASSWORD");
    });
    const user = userEvent.setup();
    render(<VaultUnlockDialog onCancel={() => undefined} onSubmit={onSubmit} />);

    await user.type(screen.getByTestId("vault-unlock-pw"), "wrong");
    await user.click(screen.getByTestId("vault-unlock-confirm"));

    expect(await screen.findByTestId("vault-unlock-error")).toHaveTextContent(
      /Incorrect master password/i,
    );
  });

  it("Esc cancels the dialog", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<VaultUnlockDialog onCancel={onCancel} onSubmit={async () => undefined} />);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
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

  it("does not cancel when the backdrop is clicked", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<VaultUnlockDialog onCancel={onCancel} onSubmit={async () => undefined} />);

    await user.click(screen.getByTestId("vault-unlock-backdrop"));

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId("vault-unlock-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("vault-unlock-pw")).toHaveFocus();
  });
});
