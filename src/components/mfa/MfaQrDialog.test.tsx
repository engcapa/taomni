import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MASTER = "qa-master-password";
vi.mock("@tauri-apps/api/core", async () => {
  const { stubMfaInvoke } = await import("../../stubs/mfaStub");
  return { invoke: (cmd: string, args?: Record<string, unknown>) => stubMfaInvoke(cmd, args, true, MASTER) };
});

import { stubMfaInvoke, MFA_STUB_STORAGE_KEY } from "../../stubs/mfaStub";
import type { MfaAccount, MfaAddResult } from "../../lib/mfa/types";
import { defaultMfaInput } from "../../lib/mfa/types";
import { MfaQrDialog } from "./MfaQrDialog";

async function seedAccount(): Promise<MfaAccount> {
  const input = { ...defaultMfaInput(), issuer: "QA Bank", accountName: "qa@example.com", secret: "JBSWY3DPEHPK3PXP" };
  const result = (await stubMfaInvoke("mfa_add", { inputs: [input], skipDuplicates: false }, true)) as MfaAddResult;
  return result.added[0];
}

describe("MfaQrDialog", () => {
  afterEach(cleanup);
  beforeEach(() => localStorage.removeItem(MFA_STUB_STORAGE_KEY));

  it("requires the master password before rendering the QR code", async () => {
    const onClose = vi.fn();
    render(<MfaQrDialog account={await seedAccount()} onClose={onClose} />);
    expect(screen.getByTestId("mfa-qr-password")).toHaveFocus();
    expect(screen.queryByTestId("mfa-qr-image")).toBeNull();

    fireEvent.click(screen.getByTestId("mfa-qr-reveal"));
    expect(screen.getByTestId("mfa-qr-error")).toHaveTextContent("Enter the master password");

    fireEvent.change(screen.getByTestId("mfa-qr-password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByTestId("mfa-qr-reveal"));
    expect(await screen.findByText("Incorrect master password.")).toBeInTheDocument();
    expect(screen.queryByTestId("mfa-qr-image")).toBeNull();

    fireEvent.change(screen.getByTestId("mfa-qr-password"), { target: { value: MASTER } });
    fireEvent.click(screen.getByTestId("mfa-qr-reveal"));
    const image = await screen.findByTestId("mfa-qr-image");
    expect(Number(image.getAttribute("data-modules"))).toBeGreaterThan(21);
    expect(image.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
    expect(screen.getByTestId("mfa-qr-dialog")).toHaveAttribute("data-state", "shown");
    expect(screen.queryByTestId("mfa-qr-password")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("mfa-qr-close")).toHaveFocus());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the close button without revealing anything", async () => {
    const onClose = vi.fn();
    render(<MfaQrDialog account={await seedAccount()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("mfa-qr-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mfa-qr-image")).toBeNull();
  });
});
