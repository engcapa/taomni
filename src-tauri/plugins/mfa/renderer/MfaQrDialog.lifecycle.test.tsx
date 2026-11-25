import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, mfaAccount } from "../../../../src/test/mfaHarness";
import type { QrSvgModel } from "../../../../src/lib/mfa/qrSvg";

const exportUri = vi.hoisted(() => vi.fn());
const qrModel = vi.hoisted(() => vi.fn());
const writeText = vi.hoisted(() => vi.fn(async (_text: string) => undefined));
vi.mock("../../../../src/lib/mfa/ipc", () => ({ mfaExportUri: exportUri }));
vi.mock("../../../../src/lib/mfa/qrSvg", () => ({ qrSvgModel: qrModel }));
vi.mock("../../../../src/lib/clipboard", () => ({ writeText }));

import { useVaultStore } from "../../../../src/stores/vaultStore";
import { MfaQrDialog } from "./MfaQrDialog";

const URI = "otpauth://hotp/QA:qa?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=0";
const MODEL: QrSvgModel = { size: 21, path: "M0 0h1v1h-1z" };

beforeEach(() => {
  exportUri.mockReset();
  qrModel.mockReset();
  writeText.mockClear();
  qrModel.mockResolvedValue(MODEL);
  useVaultStore.setState({ state: "unlocked", transitionPending: false, requiresUnlock: false,
    securityEpoch: useVaultStore.getState().securityEpoch + 1 });
});
afterEach(cleanup);

function reveal() {
  fireEvent.change(screen.getByTestId("mfa-qr-password"), { target: { value: "qa-master-password" } });
  fireEvent.click(screen.getByTestId("mfa-qr-reveal"));
}

describe("MFA secret export lifecycle", () => {
  it("closes and invalidates the local session when native Vault admission rejects export", async () => {
    exportUri.mockRejectedValue(new Error("VAULT_LOCKED"));
    const onClose = vi.fn();
    render(<MfaQrDialog account={mfaAccount()} onClose={onClose} />);
    reveal();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("mfa-qr-dialog")).toBeNull();
    expect(useVaultStore.getState()).toMatchObject({ state: "locked", requiresUnlock: true });
    expect(onClose).toHaveBeenCalledOnce();
    expect(qrModel).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("closes immediately on lock receipt and ignores a late successful secret export", async () => {
    const response = deferred<string>();
    exportUri.mockReturnValue(response.promise);
    const onClose = vi.fn();
    render(<MfaQrDialog account={mfaAccount()} initialAction="copy-secret" onClose={onClose} />);
    reveal();
    act(() => useVaultStore.setState({ state: "locked", transitionPending: true,
      securityEpoch: useVaultStore.getState().securityEpoch + 1 }));
    expect(screen.queryByTestId("mfa-qr-dialog")).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => response.resolve(URI));
    expect(qrModel).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mfa-qr-secret")).toBeNull();
  });

  it("does not publish QR or copy a secret when lock arrives while QR encoding is pending", async () => {
    const encoding = deferred<QrSvgModel>();
    exportUri.mockResolvedValue(URI);
    qrModel.mockReturnValue(encoding.promise);
    render(<MfaQrDialog account={mfaAccount()} initialAction="copy-secret" onClose={vi.fn()} />);
    reveal();
    await act(async () => { await Promise.resolve(); });
    expect(qrModel).toHaveBeenCalledWith(URI);
    act(() => useVaultStore.setState({ state: "locked", securityEpoch: useVaultStore.getState().securityEpoch + 1 }));
    await act(async () => encoding.resolve(MODEL));
    expect(screen.queryByTestId("mfa-qr-image")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("closing an export in flight prevents its automatic copy", async () => {
    const response = deferred<string>();
    exportUri.mockReturnValue(response.promise);
    render(<MfaQrDialog account={mfaAccount()} initialAction="copy-secret" onClose={vi.fn()} />);
    reveal();
    fireEvent.click(screen.getByTestId("mfa-qr-close"));
    await act(async () => response.resolve(URI));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mfa-qr-dialog")).toBeNull();
  });
});
