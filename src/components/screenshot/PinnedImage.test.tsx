import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PinnedImage } from "./PinnedImage";

const mocks = vi.hoisted(() => ({
  fetchPinInit: vi.fn(), loadScreenshotUrl: vi.fn(), revokeScreenshotUrl: vi.fn(),
  closePin: vi.fn(), closeWindow: vi.fn(), startDragging: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock("../../lib/i18n", () => ({ useT: () => mocks.translate }));
vi.mock("../../lib/screenshot", () => ({
  fetchPinInit: mocks.fetchPinInit, loadScreenshotUrl: mocks.loadScreenshotUrl,
  revokeScreenshotUrl: mocks.revokeScreenshotUrl, closePin: mocks.closePin,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "screenshot-pin-unit", close: mocks.closeWindow, startDragging: mocks.startDragging }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetchPinInit.mockResolvedValue({ path: "pin.png", width: 160, height: 120 });
  mocks.loadScreenshotUrl.mockResolvedValue("blob:pin-unit");
  mocks.closePin.mockResolvedValue(undefined);
  mocks.closeWindow.mockResolvedValue(undefined);
  mocks.startDragging.mockResolvedValue(undefined);
});
afterEach(cleanup);

// Mounted renderer/IPC checks only; N11 measures actual OS window displacement.
describe("PinnedImage", () => {
  it("retains the image over a checkerboard and requests native drag only for a first left press", async () => {
    const view = render(<PinnedImage />);
    expect(await screen.findByTestId("screenshot-pin-image")).toHaveAttribute("src", "blob:pin-unit");
    const pin = screen.getByTestId("screenshot-pin-window");
    // jsdom does not parse conic gradients; TC-SHOT-023 checks the real CSS.
    expect(pin).toHaveStyle({ backgroundColor: "#e2e2e2", backgroundSize: "16px 16px" });
    fireEvent.mouseDown(pin, { button: 0, detail: 1 });
    expect(mocks.startDragging).toHaveBeenCalledOnce();
    fireEvent.mouseDown(pin, { button: 0, detail: 2 });
    fireEvent.mouseDown(pin, { button: 1, detail: 1 });
    expect(mocks.startDragging).toHaveBeenCalledOnce();
    view.unmount();
    expect(mocks.revokeScreenshotUrl).toHaveBeenCalledWith("blob:pin-unit");
  });

  it.each(["Escape", "double-click", "right-click"])("closes only this pin on %s", async (entry) => {
    render(<PinnedImage />);
    const pin = await screen.findByTestId("screenshot-pin-window");
    if (entry === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (entry === "double-click") fireEvent.doubleClick(pin);
    else fireEvent.mouseDown(pin, { button: 2, detail: 1 });
    await waitFor(() => expect(mocks.closePin).toHaveBeenCalledWith("screenshot-pin-unit"));
    expect(mocks.startDragging).not.toHaveBeenCalled();
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });

  it("falls back to closing the window if pin IPC fails", async () => {
    mocks.closePin.mockRejectedValueOnce(new Error("session gone"));
    render(<PinnedImage />);
    await screen.findByTestId("screenshot-pin-image");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(mocks.closeWindow).toHaveBeenCalledOnce());
  });

  it("revokes a loaded URL when the pending image resolves after unmount", async () => {
    let resolve!: (url: string) => void;
    mocks.loadScreenshotUrl.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
    const view = render(<PinnedImage />);
    await waitFor(() => expect(mocks.loadScreenshotUrl).toHaveBeenCalledWith("pin.png"));
    view.unmount();
    await act(async () => resolve("blob:late-pin"));
    expect(mocks.revokeScreenshotUrl).toHaveBeenCalledWith("blob:late-pin");
    expect(screen.queryByTestId("screenshot-pin-image")).not.toBeInTheDocument();
  });
});
