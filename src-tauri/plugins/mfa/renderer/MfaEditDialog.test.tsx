import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MfaAccount } from "../../../../src/lib/mfa/types";
import { MfaEditDialog } from "./MfaEditDialog";

afterEach(cleanup);

const account: MfaAccount = {
  id: "qa-edit", issuer: "QA Edit", accountName: "edit@example.com",
  group: "", note: "", kind: "totp", algorithm: "SHA1", digits: 6,
  period: 30, counter: 0, pinned: false, sortOrder: 0, useCount: 0,
  lastUsedAt: null, createdAt: 0, updatedAt: 0,
};

it("keeps the user's field focused across parent refreshes and uses the latest close callback", () => {
  const initialClose = vi.fn();
  const latestClose = vi.fn();
  const onSaved = vi.fn();
  const { rerender } = render(<MfaEditDialog account={account} groups={[]} onClose={initialClose} onSaved={onSaved} />);
  expect(screen.getByTestId("mfa-edit-issuer")).toHaveFocus();
  const accountInput = screen.getByTestId("mfa-edit-account");
  accountInput.focus();
  fireEvent.change(accountInput, { target: { value: "renamed@example.com" } });

  // The MFA countdown refresh supplies a new inline onClose callback.
  rerender(<MfaEditDialog account={account} groups={[]} onClose={latestClose} onSaved={onSaved} />);
  expect(accountInput).toHaveFocus();
  expect(accountInput).toHaveValue("renamed@example.com");
  expect(screen.getByTestId("mfa-edit-issuer")).toHaveValue("QA Edit");
  fireEvent.keyDown(accountInput, { key: "Escape", isComposing: true });
  expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  fireEvent.keyDown(accountInput, { key: "Escape" });
  expect(screen.getByTestId("confirm-dialog-cancel")).toHaveFocus();
  fireEvent.keyDown(screen.getByTestId("confirm-dialog-cancel"), { key: "Escape" });
  expect(accountInput).toHaveFocus();
  expect(accountInput).toHaveValue("renamed@example.com");
  fireEvent.click(screen.getByTestId("mfa-edit-cancel"));
  fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
  expect(latestClose).toHaveBeenCalledOnce();
  expect(initialClose).not.toHaveBeenCalled();
});
