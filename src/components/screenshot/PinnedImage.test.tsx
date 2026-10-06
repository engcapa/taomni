import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PinnedImage } from "./PinnedImage";

const mocks = vi.hoisted(() => ({
  fetchPinInit: vi.fn(), loadScreenshotUrl: vi.fn(), revokeScreenshotUrl: vi.fn(),
  closePin: vi.fn(), closeWindow: vi.fn(), startDragging: vi.fn(),
  copy: vi.fn(), save: vi.fn(), choosePath: vi.fn(), addFavorite: vi.fn(), removeFavorite: vi.fn(),
  setSize: vi.fn(), setResizable: vi.fn(), innerSize: vi.fn(), scaleFactor: vi.fn(),
  setPinCompact: vi.fn(), setPinNote: vi.fn(), listPins: vi.fn(), arrangePins: vi.fn(), pinsBatch: vi.fn(), focusPin: vi.fn(), openPinEditor: vi.fn(), openImageEditor: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock("../../lib/i18n", () => ({ useT: () => mocks.translate }));
vi.mock("../../lib/screenshot", () => ({
  fetchPinInit: mocks.fetchPinInit, loadScreenshotUrl: mocks.loadScreenshotUrl,
  revokeScreenshotUrl: mocks.revokeScreenshotUrl, closePin: mocks.closePin,
  copyImageToClipboard: mocks.copy, saveImageToFile: mocks.save,
  addScreenshotFavorite: mocks.addFavorite, removeScreenshotFavorite: mocks.removeFavorite,
  setPinCompact: mocks.setPinCompact, setPinNote: mocks.setPinNote, listPins: mocks.listPins,
  arrangePins: mocks.arrangePins, pinsBatch: mocks.pinsBatch, focusPin: mocks.focusPin,
  openPinEditor: mocks.openPinEditor, openImageEditor: mocks.openImageEditor,
  PIN_ACTION_EVENT: "screenshot://pin-action", PINS_CHANGED_EVENT: "screenshot://pins-changed",
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.choosePath }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  LogicalSize: class { constructor(public width: number, public height: number) {} },
  getCurrentWindow: () => ({ label: "screenshot-pin-unit", close: mocks.closeWindow, startDragging: mocks.startDragging,
    setSize: mocks.setSize, setResizable: mocks.setResizable, innerSize: mocks.innerSize, scaleFactor: mocks.scaleFactor }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetchPinInit.mockResolvedValue({ path: "pin.png", width: 160, height: 120 });
  mocks.loadScreenshotUrl.mockResolvedValue("blob:pin-unit");
  mocks.closePin.mockResolvedValue(undefined);
  mocks.closeWindow.mockResolvedValue(undefined);
  mocks.startDragging.mockResolvedValue(undefined);
  mocks.copy.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
  mocks.choosePath.mockResolvedValue("saved.png");
  mocks.addFavorite.mockResolvedValue({ id: "favorite-1" });
  mocks.removeFavorite.mockResolvedValue(undefined);
  mocks.setSize.mockResolvedValue(undefined);
  mocks.setResizable.mockResolvedValue(undefined);
  mocks.setPinCompact.mockResolvedValue(undefined);
  mocks.setPinNote.mockImplementation(async (note: string) => note.trim());
  mocks.listPins.mockResolvedValue([{ label: "screenshot-pin-unit", note: "", width: 160, height: 120, order: 1 }]);
  mocks.arrangePins.mockResolvedValue(1);
  mocks.pinsBatch.mockResolvedValue(1);
  mocks.innerSize.mockResolvedValue({ width: 640, height: 480 });
  mocks.scaleFactor.mockResolvedValue(2);
});
afterEach(cleanup);

// Mounted renderer/IPC checks only; N11 measures actual OS window displacement.
describe("PinnedImage", () => {
  it("retains the image over a checkerboard and requests native drag only for a first left press", async () => {
    const view = render(<PinnedImage />);
    expect(await screen.findByTestId("screenshot-pin-image")).toHaveAttribute("src", "blob:pin-unit");
    const pin = screen.getByTestId("screenshot-pin-window");
    // jsdom does not parse conic gradients; TC-SHOT-023 checks the real CSS.
    expect(screen.getByTestId("screenshot-pin-surface")).toHaveStyle({ backgroundColor: "#e2e2e2", backgroundSize: "16px 16px" });
    fireEvent.mouseDown(pin, { button: 0, detail: 1 });
    expect(mocks.startDragging).toHaveBeenCalledOnce();
    fireEvent.mouseDown(pin, { button: 0, detail: 2 });
    fireEvent.mouseDown(pin, { button: 1, detail: 1 });
    expect(mocks.startDragging).toHaveBeenCalledOnce();
    view.unmount();
    expect(mocks.revokeScreenshotUrl).toHaveBeenCalledWith("blob:pin-unit");
  });

  it.each(["Escape", "double-click", "close-button"])("closes only this pin on %s", async (entry) => {
    render(<PinnedImage />);
    const pin = await screen.findByTestId("screenshot-pin-window");
    if (entry === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (entry === "double-click") fireEvent.doubleClick(pin);
    else fireEvent.click(screen.getByTestId("screenshot-pin-close"));
    await waitFor(() => expect(mocks.closePin).toHaveBeenCalledWith("screenshot-pin-unit"));
    expect(mocks.startDragging).not.toHaveBeenCalled();
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });

  it("opens right-click options without closing or dragging the pin", async () => {
    render(<PinnedImage />);
    const pin = await screen.findByTestId("screenshot-pin-window");
    fireEvent.contextMenu(pin);
    expect(screen.getByTestId("screenshot-pin-help")).toBeVisible();
    expect(mocks.closePin).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("screenshot-pin-menu")).not.toBeInTheDocument();
    expect(mocks.closePin).not.toHaveBeenCalled();
  });

  it("copies and saves original pixels while keeping the pin open, and save cancellation does not write", async () => {
    render(<PinnedImage />);
    await screen.findByTestId("screenshot-pin-window");
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith("pin.png"));
    await waitFor(() => expect(screen.getByTestId("screenshot-pin-copy")).toBeEnabled());
    fireEvent.click(screen.getByTestId("screenshot-pin-save"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("pin.png", "saved.png"));
    await waitFor(() => expect(screen.getByTestId("screenshot-pin-save")).toBeEnabled());
    mocks.choosePath.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByTestId("screenshot-pin-save"));
    await waitFor(() => expect(screen.getByTestId("screenshot-pin-save")).toBeEnabled());
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.closePin).not.toHaveBeenCalled();
  });

  it("recovers from a failed favorite write and toggles the persistent entry", async () => {
    mocks.addFavorite.mockRejectedValueOnce(new Error("disk full"));
    render(<PinnedImage />);
    const button = await screen.findByTestId("screenshot-pin-favorite");
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
    expect(mocks.removeFavorite).toHaveBeenCalledWith("favorite-1");
    expect(mocks.closePin).not.toHaveBeenCalled();
  });

  it("collapses and restores the actual logical window size while preserving opacity", async () => {
    render(<PinnedImage />);
    await screen.findByTestId("screenshot-pin-window");
    fireEvent.click(screen.getByTestId("screenshot-pin-menu-toggle"));
    fireEvent.change(screen.getByTestId("screenshot-pin-opacity"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("screenshot-pin-collapse"));
    await screen.findByTestId("screenshot-pin-expand");
    expect(mocks.setSize).toHaveBeenCalledWith({ width: 64, height: 64 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.setResizable).toHaveBeenCalledWith(false);
    expect(mocks.setPinCompact).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("screenshot-pin-expand"));
    await screen.findByTestId("screenshot-pin-toolbar");
    expect(mocks.setSize).toHaveBeenLastCalledWith({ width: 320, height: 240 });
    expect(mocks.setResizable).toHaveBeenLastCalledWith(true);
    expect(mocks.setPinCompact).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId("screenshot-pin-surface")).toHaveStyle({ opacity: "0.5" });
    expect(mocks.startDragging).not.toHaveBeenCalled();
  });

  it("falls back to closing the window if pin IPC fails", async () => {
    mocks.closePin.mockRejectedValueOnce(new Error("session gone"));
    render(<PinnedImage />);
    await screen.findByTestId("screenshot-pin-image");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(mocks.closeWindow).toHaveBeenCalledOnce());
  });

  it("keeps the expanded view usable and allows retry if native compact configuration fails", async () => {
    mocks.setPinCompact.mockRejectedValueOnce(new Error("window unavailable"));
    render(<PinnedImage />);
    await screen.findByTestId("screenshot-pin-toolbar");
    fireEvent.click(screen.getByTestId("screenshot-pin-collapse"));
    expect(await screen.findByRole("alert")).toHaveTextContent("window unavailable");
    expect(screen.getByTestId("screenshot-pin-window")).toHaveAttribute("data-collapsed", "false");
    expect(mocks.setSize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("screenshot-pin-collapse"));
    await screen.findByTestId("screenshot-pin-expand");
    expect(mocks.setSize).toHaveBeenCalledWith({ width: 64, height: 64 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
