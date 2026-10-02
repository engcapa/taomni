import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
  api.fetchOverlayInit.mockResolvedValue({ path: "capture.png", displayId: "0,0", width: 2048, height: 1152, scaleFactor: 2 });
  api.loadScreenshotUrl.mockResolvedValue("data:image/png;base64,stub");
  api.saveDataUrl.mockResolvedValue({ path: "export.png", width: 400, height: 300 });
  api.copyImageToClipboard.mockResolvedValue(undefined);
  api.closeScreenshotOverlay.mockResolvedValue(undefined);
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
    fireEvent.keyDown(text, { key: "Enter" });
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
