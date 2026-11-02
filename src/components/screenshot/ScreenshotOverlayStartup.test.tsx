import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
vi.mock("../../lib/ipc/application", () => ({ listSystemFonts: async () => [] }));
import { ScreenshotOverlay } from "./ScreenshotOverlay";
import { startOverlayPrefetch, takeOverlayPrefetch } from "./overlay/prefetch";
import { ScreenshotSessionGeneration } from "./overlay/sessionGeneration";
import { installOverlayCanvasStub, installOverlayImageStub } from "./overlayTestHarness";

const api = vi.hoisted(() => ({
  listDisplays: vi.fn(), fetchOverlayInit: vi.fn(), captureFull: vi.fn(), loadScreenshotUrl: vi.fn(),
  revokeScreenshotUrl: vi.fn(), closeScreenshotOverlay: vi.fn(), signalOverlayReady: vi.fn(),
  shortcutStatus: vi.fn(), isScreenshotOverlayWindow: vi.fn(),
}));
vi.mock("../../lib/screenshot", async (original) => ({
  ...await original<typeof import("../../lib/screenshot")>(), ...api,
}));
vi.mock("../../lib/runtime", async (original) => ({
  ...await original<typeof import("../../lib/runtime")>(), isTauriRuntime: () => true,
}));
vi.mock("../../lib/i18n", () => ({ useT: () => (key: string, params?: { error?: string }) => params?.error ? `${key}: ${params.error}` : key }));
vi.mock("../../lib/appDialogs", () => ({ formatUnknownError: (error: unknown) => String(error) }));

const INIT = { path: "capture.png", displayId: "0,0", width: 2048, height: 1152, scaleFactor: 2, generation: 7 };

beforeEach(() => {
  vi.clearAllMocks();
  takeOverlayPrefetch();
  api.listDisplays.mockResolvedValue([]);
  api.fetchOverlayInit.mockResolvedValue(INIT);
  api.loadScreenshotUrl.mockResolvedValue("data:image/png;base64,stub");
  api.signalOverlayReady.mockResolvedValue(true);
  api.isScreenshotOverlayWindow.mockReturnValue(false);
  api.shortcutStatus.mockResolvedValue({ accelerator: "Control+Shift+A", defaultAccelerator: "Control+Alt+A", enabled: true, registered: true, error: null });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  installOverlayImageStub();
  installOverlayCanvasStub();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ScreenshotOverlay startup", () => {
  it("stays transparent until the base image exists, then reports ready once for its session", async () => {
    let resolveInit!: (value: typeof INIT) => void;
    api.fetchOverlayInit.mockReturnValueOnce(new Promise((resolve) => { resolveInit = resolve; }));
    render(<ScreenshotOverlay />);
    const root = screen.getByTestId("screenshot-overlay");
    expect(root).toHaveAttribute("data-phase", "loading");
    expect(root.style.background).toBe("transparent");
    expect(api.signalOverlayReady).not.toHaveBeenCalled();
    // Status refresh is deferred until the base image is up.
    expect(api.shortcutStatus).not.toHaveBeenCalled();

    resolveInit(INIT);
    await screen.findByTestId("screenshot-base-image");
    await waitFor(() => expect(screen.getByTestId("screenshot-overlay")).toHaveAttribute("data-phase", "select"));
    expect(screen.getByTestId("screenshot-overlay").style.background).not.toBe("transparent");
    expect(api.signalOverlayReady).toHaveBeenCalledExactlyOnceWith(7);
    await waitFor(() => expect(api.shortcutStatus).toHaveBeenCalled());
    expect(api.captureFull).not.toHaveBeenCalled();
  });

  it("uses the host generation instead of an unconsumed first-open screenshot", async () => {
    api.fetchOverlayInit.mockResolvedValueOnce(INIT).mockResolvedValueOnce({ ...INIT, path: "new-capture.png", generation: 8 });
    api.loadScreenshotUrl.mockResolvedValueOnce("blob:old-prefetch").mockResolvedValueOnce("blob:current-session");
    startOverlayPrefetch();
    await waitFor(() => expect(api.loadScreenshotUrl).toHaveBeenCalledOnce());
    render(<ScreenshotSessionGeneration.Provider value={8}><ScreenshotOverlay /></ScreenshotSessionGeneration.Provider>);
    await screen.findByTestId("screenshot-base-image");
    await waitFor(() => expect(api.signalOverlayReady).toHaveBeenCalledExactlyOnceWith(8));
    expect(api.loadScreenshotUrl).toHaveBeenNthCalledWith(2, "new-capture.png");
    expect(api.revokeScreenshotUrl).toHaveBeenCalledExactlyOnceWith("blob:old-prefetch");
    expect(api.captureFull).not.toHaveBeenCalled();
  });

  it("consumes a prefetched payload instead of requesting it again", async () => {
    startOverlayPrefetch();
    render(<ScreenshotOverlay />);
    await screen.findByTestId("screenshot-base-image");
    expect(api.fetchOverlayInit).toHaveBeenCalledOnce();
    expect(api.loadScreenshotUrl).toHaveBeenCalledOnce();
    await waitFor(() => expect(api.signalOverlayReady).toHaveBeenCalledExactlyOnceWith(7));
  });

  it("shares a pending prefetch across StrictMode setup cleanup without rereading or revoking its image", async () => {
    let finishRead!: (url: string) => void;
    api.loadScreenshotUrl.mockReturnValue(new Promise<string>((resolve) => { finishRead = resolve; }));
    startOverlayPrefetch();
    const rendered = render(<StrictMode><ScreenshotOverlay /></StrictMode>);
    await waitFor(() => expect(api.loadScreenshotUrl).toHaveBeenCalled());
    expect(api.fetchOverlayInit).toHaveBeenCalledOnce();
    expect(api.loadScreenshotUrl).toHaveBeenCalledOnce();
    finishRead("blob:strict-overlay");
    await screen.findByTestId("screenshot-base-image");
    expect(api.signalOverlayReady).toHaveBeenCalledExactlyOnceWith(7);
    expect(api.revokeScreenshotUrl).not.toHaveBeenCalled();
    rendered.unmount();
    await waitFor(() => expect(api.revokeScreenshotUrl).toHaveBeenCalledExactlyOnceWith("blob:strict-overlay"));
  });

  it("releases a prefetched image even when its read finishes after unmount", async () => {
    let finishRead!: (url: string) => void;
    api.loadScreenshotUrl.mockReturnValue(new Promise<string>((resolve) => { finishRead = resolve; }));
    startOverlayPrefetch();
    const rendered = render(<ScreenshotOverlay />);
    await waitFor(() => expect(api.loadScreenshotUrl).toHaveBeenCalledOnce());
    rendered.unmount();
    finishRead("blob:late-overlay");
    await waitFor(() => expect(api.revokeScreenshotUrl).toHaveBeenCalledExactlyOnceWith("blob:late-overlay"));
    expect(api.signalOverlayReady).not.toHaveBeenCalled();
  });

  it("never captures live when the backend session failed, and still releases the window", async () => {
    api.fetchOverlayInit.mockRejectedValueOnce(new Error("screenshot opening was cancelled"));
    render(<ScreenshotOverlay />);
    expect(await screen.findByTestId("screenshot-overlay-error")).toHaveTextContent("screenshot opening was cancelled");
    expect(api.captureFull).not.toHaveBeenCalled();
    // No payload means no generation to release; the backend times out.
    expect(api.signalOverlayReady).not.toHaveBeenCalled();
  });

  it("captures live only for a direct open outside the native overlay window", async () => {
    api.isScreenshotOverlayWindow.mockReturnValue(true);
    api.fetchOverlayInit.mockRejectedValue(new Error("no pending screenshot overlay"));
    render(<ScreenshotOverlay />);
    expect(await screen.findByTestId("screenshot-overlay-error")).toHaveTextContent("no pending screenshot overlay");
    expect(api.captureFull).not.toHaveBeenCalled();
  });

  it("reports ready with the payload generation when the base image cannot load", async () => {
    api.loadScreenshotUrl.mockRejectedValueOnce(new Error("artifact read failed"));
    render(<ScreenshotOverlay />);
    expect(await screen.findByTestId("screenshot-overlay-error")).toHaveTextContent("artifact read failed");
    await waitFor(() => expect(api.signalOverlayReady).toHaveBeenCalledExactlyOnceWith(7));
  });
});
