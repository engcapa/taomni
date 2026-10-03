import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../lib/ipc", () => ({ listSystemFonts: async () => ["Arial", "Noto Sans"] }));
import { ScreenshotOverlay } from "./ScreenshotOverlay";

const api = vi.hoisted(() => ({
  fetchOverlayInit: vi.fn(), captureFull: vi.fn(), loadScreenshotUrl: vi.fn(), revokeScreenshotUrl: vi.fn(),
  closeScreenshotOverlay: vi.fn(), saveDataUrl: vi.fn(), copyImageToClipboard: vi.fn(),
  saveImageToFile: vi.fn(), pinToScreen: vi.fn(), ocrImage: vi.fn(), autoRedact: vi.fn(),
  scrollCapture: vi.fn(), updateOverlayImage: vi.fn(), startRecording: vi.fn(),
}));
vi.mock("../../lib/screenshot", async (original) => ({
  ...await original<typeof import("../../lib/screenshot")>(), ...api,
}));
vi.mock("../../lib/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../lib/appDialogs", () => ({ formatUnknownError: (error: unknown) => String(error) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
  api.fetchOverlayInit.mockResolvedValue({ path: "capture.png", displayId: "0,0", width: 2048, height: 1152, scaleFactor: 2 });
  api.loadScreenshotUrl.mockResolvedValue("data:image/png;base64,stub");
  api.saveDataUrl.mockResolvedValue({ path: "export.png", width: 400, height: 300 });
  api.copyImageToClipboard.mockResolvedValue(undefined);
  api.closeScreenshotOverlay.mockResolvedValue(undefined);
  api.updateOverlayImage.mockResolvedValue(undefined);
  api.ocrImage.mockResolvedValue({ text: "user@example.com" });
  api.autoRedact.mockResolvedValue({ count: 2, boxes: [{ x: 10, y: 20, w: 40, h: 20 }, { x: 80, y: 20, w: 40, h: 20 }] });
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    let width = 2048, height = 1152;
    Object.defineProperties(image, {
      naturalWidth: { get: () => width }, naturalHeight: { get: () => height },
      src: { set: (url: string) => {
        const size = /base64,(\d+)x(\d+)$/.exec(url);
        if (size) { width = Number(size[1]); height = Number(size[2]); }
        queueMicrotask(() => image.onload?.(new Event("load")));
      } },
    });
    return image;
  });
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get: (target, name) => {
      if (name === "getTransform") return () => ({ a: 1 });
      if (name === "getImageData") return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (!Reflect.has(target, name)) Reflect.set(target, name, vi.fn());
      return Reflect.get(target, name);
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
    return `data:image/png;base64,${this.width}x${this.height}`;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function open() {
  render(<ScreenshotOverlay />);
  await screen.findByTestId("screenshot-hint");
}
function drag(id: string, from: [number, number], to: [number, number]) {
  const el = screen.getByTestId(id);
  fireEvent.mouseDown(el, { button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.mouseMove(el, { clientX: to[0], clientY: to[1] });
  fireEvent.mouseUp(el, { button: 0, clientX: to[0], clientY: to[1] });
}
const shapes = () => screen.getByTestId("screenshot-annotation-canvas").getAttribute("data-shapes");

describe("ScreenshotOverlay", () => {
  it("preselects the current window without hiding it in a new full-display selection", async () => {
    api.fetchOverlayInit.mockResolvedValueOnce({ path: "window.png", displayId: "0,0", width: 2048, height: 1152, scaleFactor: 2,
      windowRegion: { x: 200, y: 150, width: 800, height: 600 } });
    render(<ScreenshotOverlay />);
    await screen.findByTestId("screenshot-toolbar");
    expect(screen.getByTestId("screenshot-selection")).toHaveStyle({ left: "100px", top: "100px", width: "400px", height: "400px" });
    expect(screen.getByTestId("screenshot-size-hint")).toHaveTextContent("800 × 600");
  });

  it("selects, moves, resizes, restyles and deletes a mark with independent undo steps", async () => {
    await open();
    drag("screenshot-select-layer", [100, 100], [500, 450]);
    fireEvent.click(screen.getByTestId("screenshot-tool-rect"));
    drag("screenshot-annotation-layer", [130, 130], [230, 210]);
    fireEvent.click(screen.getByTestId("screenshot-tool-move"));
    drag("screenshot-annotation-layer", [150, 150], [220, 230]);
    expect(shapes()).toBe("1");
    expect(screen.getByTestId("screenshot-annotation-selection")).toHaveStyle({ left: "200px", top: "210px", width: "100px", height: "80px" });
    fireEvent.click(screen.getByTestId("screenshot-undo"));
    expect(screen.getByTestId("screenshot-annotation-selection")).toHaveStyle({ left: "130px", top: "130px" });
    fireEvent.click(screen.getByTestId("screenshot-redo"));
    drag("screenshot-annotation-resize-se", [300, 290], [350, 330]);
    expect(screen.getByTestId("screenshot-annotation-selection")).toHaveStyle({ width: "150px", height: "120px" });
    fireEvent.click(screen.getByTestId("screenshot-color-green"));
    fireEvent.click(screen.getByTestId("screenshot-line-width-8"));
    const ctx = (screen.getByTestId("screenshot-annotation-canvas") as HTMLCanvasElement).getContext("2d")!;
    expect(ctx.strokeStyle).toBe("#52c41a");
    expect(ctx.lineWidth).toBe(8);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(shapes()).toBe("0");
    expect(screen.queryByTestId("screenshot-annotation-selection")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("screenshot-undo"));
    expect(shapes()).toBe("1");
  });

  it("edits selected text in place and Escape preserves the original text", async () => {
    await open();
    fireEvent.click(screen.getByTestId("screenshot-fullscreen"));
    fireEvent.click(screen.getByTestId("screenshot-tool-text"));
    fireEvent.click(screen.getByTestId("screenshot-annotation-layer"), { clientX: 100, clientY: 100 });
    fireEvent.change(screen.getByTestId("screenshot-text-input"), { target: { value: "first" } });
    fireEvent.keyDown(screen.getByTestId("screenshot-text-input"), { key: "Enter", ctrlKey: true });
    fireEvent.click(screen.getByTestId("screenshot-tool-move"));
    fireEvent.doubleClick(screen.getByTestId("screenshot-annotation-layer"), { clientX: 110, clientY: 110 });
    expect(screen.getByTestId("screenshot-text-input")).toHaveValue("first");
    fireEvent.change(screen.getByTestId("screenshot-text-input"), { target: { value: "edited" } });
    fireEvent.keyDown(screen.getByTestId("screenshot-text-input"), { key: "Enter", ctrlKey: true });
    expect(shapes()).toBe("1");
    fireEvent.doubleClick(screen.getByTestId("screenshot-annotation-layer"), { clientX: 110, clientY: 110 });
    expect(screen.getByTestId("screenshot-text-input")).toHaveValue("edited");
    fireEvent.keyDown(screen.getByTestId("screenshot-text-input"), { key: "Escape" });
    expect(shapes()).toBe("1");
  });

  it("keeps Enter and IME input open, commits multiline font settings and restores them on undo", async () => {
    await open();
    fireEvent.click(screen.getByTestId("screenshot-fullscreen"));
    fireEvent.click(screen.getByTestId("screenshot-tool-text"));
    fireEvent.change(screen.getByTestId("screenshot-font-family"), { target: { value: "monospace" } });
    fireEvent.change(screen.getByTestId("screenshot-font-size"), { target: { value: "32" } });
    fireEvent.click(screen.getByTestId("screenshot-annotation-layer"), { clientX: 100, clientY: 100 });
    const input = screen.getByTestId("screenshot-text-input");
    expect(input.tagName).toBe("TEXTAREA");
    expect(input).toHaveStyle({ fontFamily: "monospace", fontSize: "32px" });
    fireEvent.change(input, { target: { value: "first\n第二行" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(shapes()).toBe("0");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(shapes()).toBe("0");
    fireEvent.blur(input);
    expect(shapes()).toBe("1");
    const ctx = (screen.getByTestId("screenshot-annotation-canvas") as HTMLCanvasElement).getContext("2d")!;
    expect(ctx.fillText).toHaveBeenCalledWith("first", 100, 100);
    expect(ctx.fillText).toHaveBeenCalledWith("第二行", 100, 138.4);
    fireEvent.click(screen.getByTestId("screenshot-tool-move"));
    fireEvent.mouseDown(screen.getByTestId("screenshot-annotation-layer"), { button: 0, clientX: 110, clientY: 145 });
    fireEvent.mouseUp(window, { clientX: 110, clientY: 145 });
    expect(screen.getByTestId("screenshot-annotation-selection")).toHaveStyle({ height: "76.8px" });
    fireEvent.change(screen.getByTestId("screenshot-font-size"), { target: { value: "24" } });
    fireEvent.click(screen.getByTestId("screenshot-undo"));
    expect(screen.getByTestId("screenshot-font-size")).toHaveValue(32);
    fireEvent.doubleClick(screen.getByTestId("screenshot-annotation-layer"), { clientX: 110, clientY: 145 });
    expect(screen.getByTestId("screenshot-text-input")).toHaveValue("first\n第二行");
    expect(api.copyImageToClipboard).not.toHaveBeenCalled();
  });

  it("previews tall scroll results without selecting again, and copies full native dimensions", async () => {
    await open();
    fireEvent.click(screen.getByTestId("screenshot-fullscreen"));
    api.scrollCapture.mockResolvedValueOnce({ path: "tall.png", width: 400, height: 2400, frames: 6 });
    api.loadScreenshotUrl.mockResolvedValueOnce("data:image/png;base64,400x2400");
    api.updateOverlayImage.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByTestId("screenshot-scroll-capture"));
    fireEvent.click(screen.getByTestId("screenshot-scroll-start"));
    await screen.findByTestId("screenshot-scroll-result");
    expect(screen.queryByTestId("screenshot-hint")).not.toBeInTheDocument();
    expect(screen.getByTestId("screenshot-toolbar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("screenshot-scroll-actual"));
    expect(screen.getByTestId("screenshot-scroll-result-image")).toHaveStyle({ width: "400px", height: "2400px" });
    fireEvent.click(screen.getByTestId("screenshot-scroll-fit"));
    fireEvent.click(screen.getByTestId("screenshot-tool-rect"));
    const layer = screen.getByTestId("screenshot-annotation-layer");
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ left: 300, top: 100, width: 100, height: 600 } as DOMRect);
    drag("screenshot-annotation-layer", [310, 120], [330, 150]);
    expect(shapes()).toBe("1");
    fireEvent.click(screen.getByTestId("screenshot-tool-move"));
    drag("screenshot-annotation-layer", [315, 130], [315, 130]);
    expect(screen.getByTestId("screenshot-annotation-selection")).toHaveStyle({ left: "40px", top: "80px", width: "80px", height: "120px" });
    fireEvent.click(screen.getByTestId("screenshot-scroll-actual"));
    expect(shapes()).toBe("1");
    fireEvent.click(screen.getByTestId("screenshot-undo"));
    expect(shapes()).toBe("0");
    fireEvent.click(screen.getByTestId("screenshot-redo"));
    expect(shapes()).toBe("1");
    fireEvent.click(screen.getByTestId("screenshot-scroll-result-copy"));
    await waitFor(() => expect(api.closeScreenshotOverlay).toHaveBeenCalledOnce());
    expect(api.saveDataUrl).toHaveBeenCalledWith("data:image/png;base64,400x2400");
  });

  it("exits a marked scroll preview directly with Escape without copying", async () => {
    await open();
    fireEvent.click(screen.getByTestId("screenshot-fullscreen"));
    api.scrollCapture.mockResolvedValueOnce({ path: "tall.png", width: 400, height: 2400, frames: 6 });
    api.loadScreenshotUrl.mockResolvedValueOnce("data:image/png;base64,400x2400");
    fireEvent.click(screen.getByTestId("screenshot-scroll-capture"));
    fireEvent.click(screen.getByTestId("screenshot-scroll-start"));
    await screen.findByTestId("screenshot-scroll-result");
    fireEvent.click(screen.getByTestId("screenshot-tool-rect"));
    drag("screenshot-annotation-layer", [40, 80], [120, 200]);
    expect(shapes()).toBe("1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(api.closeScreenshotOverlay).toHaveBeenCalledOnce();
    expect(api.copyImageToClipboard).not.toHaveBeenCalled();
  });

  it("explains scroll capture before starting and keeps the original image when cancelled", async () => {
    await open();
    drag("screenshot-select-layer", [100, 100], [500, 450]);
    fireEvent.click(screen.getByTestId("screenshot-scroll-capture"));
    expect(screen.getByTestId("screenshot-scroll-instructions")).toBeInTheDocument();
    expect(api.scrollCapture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("screenshot-scroll-confirm-cancel"));
    expect(screen.queryByTestId("screenshot-scroll-confirm")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("screenshot-scroll-capture"));
    api.scrollCapture.mockRejectedValueOnce(new Error("scroll capture cancelled"));
    fireEvent.click(screen.getByTestId("screenshot-scroll-start"));
    await waitFor(() => expect(screen.getByTestId("screenshot-overlay")).toHaveAttribute("data-phase", "annotate"));
    expect(screen.getByTestId("screenshot-selection")).toHaveStyle({ left: "100px", top: "100px" });
    expect(api.updateOverlayImage).not.toHaveBeenCalled();
  });
  it.each(["button", "Escape"])("keeps scroll permission instructions visible and lets the user exit with %s", async (exit) => {
    await open();
    drag("screenshot-select-layer", [100, 100], [500, 450]);
    api.scrollCapture.mockRejectedValueOnce(new Error("Scrolling capture requires macOS Accessibility permission"));
    fireEvent.click(screen.getByTestId("screenshot-scroll-capture"));
    fireEvent.click(screen.getByTestId("screenshot-scroll-start"));
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("screenshot.scrollFailed");
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(5000));
    expect(error).toBeInTheDocument();
    expect(screen.getByTestId("screenshot-overlay")).toHaveAttribute("data-phase", "annotate");
    expect(api.updateOverlayImage).not.toHaveBeenCalled();
    if (exit === "button") fireEvent.click(error.querySelector("button")!);
    else fireEvent.keyDown(window, { key: "Escape" });
    expect(api.closeScreenshotOverlay).toHaveBeenCalledOnce();
  });

  it("selects reverse drags, activates a tool explicitly and copies an integral per-axis crop", async () => {
    await open();
    drag("screenshot-select-layer", [300, 300], [100, 100]);
    expect(screen.getByTestId("screenshot-size-hint")).toHaveTextContent("400 × 300");
    expect(screen.getByTestId("screenshot-tool-rect")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("screenshot-tool-rect"));
    drag("screenshot-annotation-layer", [130, 130], [200, 200]);
    expect(shapes()).toBe("1");
    fireEvent.click(screen.getByTestId("screenshot-undo"));
    expect(shapes()).toBe("0");
    fireEvent.click(screen.getByTestId("screenshot-redo"));
    expect(shapes()).toBe("1");
    fireEvent.click(screen.getByTestId("screenshot-copy"));
    await waitFor(() => expect(api.closeScreenshotOverlay).toHaveBeenCalledOnce());
    expect(api.saveDataUrl).toHaveBeenCalledWith("data:image/png;base64,400x300");
    expect(api.copyImageToClipboard).toHaveBeenCalledWith("export.png");
  });

  it("rejects tiny selections and clamps moved/resized selections without losing annotations", async () => {
    await open();
    drag("screenshot-select-layer", [10, 10], [12, 13]);
    expect(screen.queryByTestId("screenshot-toolbar")).not.toBeInTheDocument();
    drag("screenshot-select-layer", [100, 100], [300, 300]);
    fireEvent.click(screen.getByTestId("screenshot-tool-rect"));
    drag("screenshot-annotation-layer", [130, 130], [200, 200]);
    fireEvent.click(screen.getByTestId("screenshot-recrop"));
    drag("screenshot-handle-se", [300, 300], [350, 340]);
    expect(shapes()).toBe("1");
    expect(screen.getByTestId("screenshot-size-hint")).toHaveTextContent("500 × 360");
    drag("screenshot-selection-move", [200, 200], [-500, -500]);
    expect(screen.getByTestId("screenshot-selection")).toHaveStyle({ left: "0px", top: "0px" });
    expect(shapes()).toBe("1");
  });

  it("closes a freehand selection, scales its contour and retains annotation history when switching to rectangle", async () => {
    await open();
    fireEvent.click(screen.getByTestId("screenshot-selection-freehand"));
    const layer = screen.getByTestId("screenshot-select-layer");
    fireEvent.mouseDown(layer, { button: 0, clientX: 100, clientY: 100 });
    for (const [x, y] of [[300, 100], [300, 180], [180, 180], [180, 300], [100, 300]]) {
      fireEvent.mouseMove(window, { clientX: x, clientY: y });
    }
    fireEvent.mouseUp(window, { clientX: 100, clientY: 300 });
    expect(screen.getByTestId("screenshot-freehand-contour")).toHaveAttribute("d", expect.stringMatching(/ Z$/));
    expect(screen.getByTestId("screenshot-scroll-capture")).toBeDisabled();
    expect(screen.getByTestId("screenshot-record")).toBeDisabled();
    fireEvent.click(screen.getByTestId("screenshot-tool-rect"));
    drag("screenshot-annotation-layer", [110, 120], [160, 160]);
    expect(shapes()).toBe("1");
    fireEvent.click(screen.getByTestId("screenshot-recrop"));
    drag("screenshot-handle-se", [300, 300], [400, 400]);
    expect(screen.getByTestId("screenshot-freehand-contour")).toHaveAttribute("d", "M 100 100 L 400 100 L 400 220 L 220 220 L 220 400 L 100 400 Z");
    fireEvent.click(screen.getByTestId("screenshot-selection-rectangle"));
    expect(screen.queryByTestId("screenshot-freehand-contour")).not.toBeInTheDocument();
    expect(screen.getByTestId("screenshot-record")).toBeEnabled();
    expect(shapes()).toBe("1");
  });

  it("rejects a diagonal freehand gesture and reselects from a contour's empty bounding-box area", async () => {
    await open();
    fireEvent.click(screen.getByTestId("screenshot-selection-freehand"));
    drag("screenshot-select-layer", [100, 100], [400, 400]);
    expect(screen.queryByTestId("screenshot-toolbar")).not.toBeInTheDocument();
    const layer = screen.getByTestId("screenshot-select-layer");
    fireEvent.mouseDown(layer, { button: 0, clientX: 100, clientY: 100 });
    for (const [x, y] of [[150, 137], [200, 175], [250, 212], [300, 250], [350, 287], [400, 325], [450, 362]]) {
      fireEvent.mouseMove(window, { clientX: x, clientY: y });
    }
    fireEvent.mouseUp(window, { clientX: 500, clientY: 400 });
    expect(screen.queryByTestId("screenshot-toolbar")).not.toBeInTheDocument();
    fireEvent.mouseDown(layer, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 300, clientY: 100 });
    fireEvent.mouseUp(window, { clientX: 100, clientY: 300 });
    fireEvent.click(screen.getByTestId("screenshot-tool-rect"));
    fireEvent.mouseDown(screen.getByTestId("screenshot-annotation-layer"), { button: 0, clientX: 290, clientY: 290 });
    expect(screen.getByTestId("screenshot-overlay")).toHaveAttribute("data-phase", "select");
    expect(shapes()).toBe("0");
    fireEvent.mouseUp(window, { clientX: 290, clientY: 290 });
  });

  it("applies the freehand mask after watermarking and sends the same natural-size crop to Pin", async () => {
    await open();
    fireEvent.click(screen.getByTestId("screenshot-selection-freehand"));
    const layer = screen.getByTestId("screenshot-select-layer");
    fireEvent.mouseDown(layer, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 300, clientY: 100 });
    fireEvent.mouseUp(window, { clientX: 100, clientY: 300 });
    fireEvent.click(screen.getByTestId("screenshot-watermark"));
    fireEvent.change(screen.getByTestId("screenshot-watermark-text"), { target: { value: "masked watermark" } });
    fireEvent.click(screen.getByTestId("screenshot-watermark-apply"));
    const ctx = (screen.getByTestId("screenshot-annotation-canvas") as HTMLCanvasElement).getContext("2d")!;
    vi.mocked(ctx.fill).mockClear();
    fireEvent.click(screen.getByTestId("screenshot-pin"));
    await waitFor(() => expect(api.closeScreenshotOverlay).toHaveBeenCalledOnce());
    expect(ctx.fill).toHaveBeenCalledWith("evenodd");
    expect(vi.mocked(ctx.fillText).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(ctx.fill).mock.invocationCallOrder.at(-1)!);
    expect(api.saveDataUrl).toHaveBeenCalledWith("data:image/png;base64,400x300");
    expect(api.pinToScreen).toHaveBeenCalledWith("export.png");
  });

  it("owns annotation text shortcuts and adds rapid number clicks only once", async () => {
    await open();
    fireEvent.click(screen.getByTestId("screenshot-fullscreen"));
    fireEvent.click(screen.getByTestId("screenshot-tool-text"));
    fireEvent.click(screen.getByTestId("screenshot-annotation-layer"), { clientX: 100, clientY: 100 });
    const text = screen.getByTestId("screenshot-text-input");
    fireEvent.change(text, { target: { value: "hello" } });
    fireEvent.keyDown(text, { key: "Enter", ctrlKey: true });
    expect(shapes()).toBe("1");
    expect(api.copyImageToClipboard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("screenshot-tool-number"));
    const layer = screen.getByTestId("screenshot-annotation-layer");
    for (let i = 0; i < 3; i++) {
      fireEvent.mouseDown(layer, { button: 0, clientX: 200 + i * 40, clientY: 200 });
      fireEvent.mouseUp(layer, { clientX: 200 + i * 40, clientY: 200 });
      fireEvent.click(layer, { clientX: 200 + i * 40, clientY: 200 });
    }
    expect(shapes()).toBe("4");
  });

  it("renders load errors with a usable cancel action", async () => {
    api.fetchOverlayInit.mockRejectedValueOnce(new Error("no pending capture"));
    api.captureFull.mockRejectedValueOnce(new Error("screen permission denied"));
    render(<ScreenshotOverlay />);
    await screen.findByTestId("screenshot-overlay-error");
    expect(screen.queryByTestId("screenshot-base-image")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("screenshot-cancel"));
    await waitFor(() => expect(api.closeScreenshotOverlay).toHaveBeenCalledOnce());
  });

  it("applies watermark text to the selected export without expanding its dimensions", async () => {
    await open();
    drag("screenshot-select-layer", [100, 100], [300, 300]);
    fireEvent.click(screen.getByTestId("screenshot-watermark"));
    fireEvent.change(screen.getByTestId("screenshot-watermark-text"), { target: { value: "QA watermark" } });
    fireEvent.click(screen.getByTestId("screenshot-watermark-apply"));
    const ctx = screen.getByTestId("screenshot-annotation-canvas") as HTMLCanvasElement;
    const fillText = ctx.getContext("2d")!.fillText;
    vi.mocked(fillText).mockClear();
    fireEvent.click(screen.getByTestId("screenshot-copy"));
    await waitFor(() => expect(api.closeScreenshotOverlay).toHaveBeenCalledOnce());
    expect(api.saveDataUrl).toHaveBeenCalledWith("data:image/png;base64,400x300");
    expect(fillText).toHaveBeenCalledWith("QA watermark", expect.any(Number), expect.any(Number));
  });

  it("keeps a failed copy retryable and commits auto-redaction as one history step", async () => {
    await open();
    fireEvent.click(screen.getByTestId("screenshot-fullscreen"));
    fireEvent.click(screen.getByTestId("screenshot-auto-redact"));
    await waitFor(() => expect(shapes()).toBe("2"));
    expect(screen.getByTestId("screenshot-undo")).toBeEnabled();
    fireEvent.click(screen.getByTestId("screenshot-undo"));
    expect(shapes()).toBe("0");
    fireEvent.click(screen.getByTestId("screenshot-redo"));
    expect(shapes()).toBe("2");
    api.copyImageToClipboard.mockRejectedValueOnce(new Error("clipboard busy"));
    fireEvent.click(screen.getByTestId("screenshot-copy"));
    await screen.findByTestId("screenshot-toast");
    expect(api.closeScreenshotOverlay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("screenshot-copy"));
    await waitFor(() => expect(api.closeScreenshotOverlay).toHaveBeenCalledOnce());
  });
});
