import { cleanup, render, screen } from "@testing-library/react";
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

  it("cancels via Escape", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<VaultSetupDialog onCancel={onCancel} onSubmit={async () => undefined} />);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });
});
