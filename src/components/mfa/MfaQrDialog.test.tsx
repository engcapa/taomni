import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeText = vi.fn(async (_text: string) => undefined);
vi.mock("../../lib/clipboard", () => ({
  writeText: (text: string) => writeText(text),
  readClipboardImageFiles: async () => [],
}));

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
  beforeEach(() => {
    localStorage.removeItem(MFA_STUB_STORAGE_KEY);
    writeText.mockClear();
  });

  it("requires the master password before rendering the QR code and secret", async () => {
    const onClose = vi.fn();
    render(<MfaQrDialog account={await seedAccount()} onClose={onClose} />);
    expect(screen.getByTestId("mfa-qr-password")).toHaveFocus();
    expect(screen.queryByTestId("mfa-qr-image")).toBeNull();
    expect(screen.queryByTestId("mfa-qr-secret")).toBeNull();

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

    // Secret is initially masked
    expect(screen.getByTestId("mfa-qr-secret")).toHaveTextContent("•••• •••• •••• ••••");

    // Toggle mask reveals formatted Base32 secret
    fireEvent.click(screen.getByTestId("mfa-qr-toggle-secret"));
    expect(screen.getByTestId("mfa-qr-secret")).toHaveTextContent("JBSW Y3DP EHPK 3PXP");

    // Copy secret button writes raw clean Base32 to clipboard
    fireEvent.click(screen.getByTestId("mfa-qr-copy-secret"));
    expect(writeText).toHaveBeenCalledWith("JBSWY3DPEHPK3PXP");

    // Copy URI button writes full otpauth URI to clipboard
    fireEvent.click(screen.getByTestId("mfa-qr-copy-uri"));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("otpauth://totp/QA%20Bank:qa%40example.com"));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("automatically copies secret key and calls onCopiedSecret when initialAction is copy-secret", async () => {
    const onClose = vi.fn();
    const onCopiedSecret = vi.fn();
    render(
      <MfaQrDialog
        account={await seedAccount()}
        initialAction="copy-secret"
        onClose={onClose}
        onCopiedSecret={onCopiedSecret}
      />,
    );

    fireEvent.change(screen.getByTestId("mfa-qr-password"), { target: { value: MASTER } });
    fireEvent.click(screen.getByTestId("mfa-qr-reveal"));

    await screen.findByTestId("mfa-qr-image");
    expect(writeText).toHaveBeenCalledWith("JBSWY3DPEHPK3PXP");
    expect(onCopiedSecret).toHaveBeenCalledWith("QA Bank · qa@example.com");
  });

  it("closes from the close button without revealing anything", async () => {
    const onClose = vi.fn();
    render(<MfaQrDialog account={await seedAccount()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("mfa-qr-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mfa-qr-image")).toBeNull();
  });
});
