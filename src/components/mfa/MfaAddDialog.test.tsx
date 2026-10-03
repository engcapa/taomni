import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOTP_LINK = "otpauth://hotp/QA%20Bank:qa.hotp%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=QA%20Bank&counter=0";
const decodeImageBlob = vi.fn(async (_blob: Blob): Promise<string[]> => [HOTP_LINK]);
const decodeVideoFrame = vi.fn(async (): Promise<string | null> => HOTP_LINK);

vi.mock("../../lib/clipboard", () => ({ writeText: async () => undefined, readClipboardImageFiles: async () => [new File(["x"], "shot.png", { type: "image/png" })] }));
vi.mock("../../lib/mfa/qrImage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mfa/qrImage")>()),
  decodeImageBlob: (blob: Blob) => decodeImageBlob(blob),
  decodeVideoFrame: () => decodeVideoFrame(),
}));
vi.mock("@tauri-apps/api/core", async () => {
  const { stubMfaInvoke } = await import("../../stubs/mfaStub");
  return { invoke: (cmd: string, args?: Record<string, unknown>) => stubMfaInvoke(cmd, args, true) };
});

import { MFA_STUB_STORAGE_KEY } from "../../stubs/mfaStub";
import { useMfaStore } from "../../stores/mfaStore";
import { MfaAddDialog } from "./MfaAddDialog";

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value });
}

describe("MfaAddDialog import sources", () => {
  afterEach(cleanup);
  beforeEach(() => {
    localStorage.removeItem(MFA_STUB_STORAGE_KEY);
    decodeImageBlob.mockClear();
    useMfaStore.setState({ accounts: [], codes: {} });
  });

  it("imports a chosen QR image through the preview and flags duplicates afterwards", async () => {
    const onAdded = vi.fn();
    const { unmount } = render(<MfaAddDialog initialMode="image" onClose={vi.fn()} onAdded={onAdded} />);
    fireEvent.change(screen.getByTestId("mfa-image-file"), { target: { files: [new File(["png"], "qr.png", { type: "image/png" })] } });
    expect(await screen.findByTestId("mfa-import-preview")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("mfa-import-issuer")).toHaveValue("QA Bank"));
    fireEvent.change(screen.getByTestId("mfa-import-group"), { target: { value: "Work" } });
    fireEvent.click(screen.getByTestId("mfa-import-confirm"));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1));
    expect(JSON.parse(localStorage.getItem(MFA_STUB_STORAGE_KEY)!).accounts[0]).toMatchObject({ issuer: "QA Bank", group: "Work", kind: "hotp" });
    unmount();

    render(<MfaAddDialog initialMode="image" onClose={vi.fn()} onAdded={onAdded} />);
    fireEvent.click(screen.getByTestId("mfa-image-paste"));
    expect(await screen.findByTestId("mfa-import-duplicate")).toHaveTextContent("Already added");
    expect(screen.getByTestId("mfa-import-confirm")).toBeDisabled();
    expect(screen.getByTestId("mfa-import-all-duplicates")).toBeInTheDocument();
  });

  it("reports non-OTP and missing QR codes on the image pane", async () => {
    render(<MfaAddDialog initialMode="image" onClose={vi.fn()} onAdded={vi.fn()} />);
    decodeImageBlob.mockResolvedValueOnce(["https://example.com/not-an-otp"]);
    fireEvent.change(screen.getByTestId("mfa-image-file"), { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByTestId("mfa-image-status")).toHaveTextContent("not an MFA QR code"));
    decodeImageBlob.mockResolvedValueOnce([]);
    fireEvent.change(screen.getByTestId("mfa-image-file"), { target: { files: [new File(["x"], "b.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByTestId("mfa-image-status")).toHaveTextContent("No QR code found"));
  });

  it("explains that screen scanning needs the desktop app in browser preview", async () => {
    render(<MfaAddDialog initialMode="screen" onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.click(screen.getByTestId("mfa-screen-scan"));
    await waitFor(() => expect(screen.getByTestId("mfa-screen-status")).toHaveTextContent("only available in the desktop app"));
  });

  it("handles missing cameras, denial and a successful scan that releases the camera", async () => {
    setMediaDevices({ enumerateDevices: async () => [], getUserMedia: vi.fn() });
    const { unmount } = render(<MfaAddDialog initialMode="camera" onClose={vi.fn()} onAdded={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("mfa-camera-state")).toHaveAttribute("data-state", "no-camera"));
    unmount();

    const camera = { kind: "videoinput", deviceId: "cam", label: "QA camera", groupId: "g" };
    setMediaDevices({ enumerateDevices: async () => [camera], getUserMedia: vi.fn(async () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }))) });
    const second = render(<MfaAddDialog initialMode="camera" onClose={vi.fn()} onAdded={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("mfa-camera-state")).toHaveAttribute("data-state", "denied"));
    second.unmount();

    const stop = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    setMediaDevices({ enumerateDevices: async () => [camera], getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) });
    render(<MfaAddDialog initialMode="camera" onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(await screen.findByTestId("mfa-import-preview")).toBeInTheDocument();
    expect(stop).toHaveBeenCalled();
  });
});
