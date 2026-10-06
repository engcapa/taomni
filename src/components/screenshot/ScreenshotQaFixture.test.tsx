import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenshotQaFixture } from "./ScreenshotQaFixture";

describe("ScreenshotQaFixture publication", () => {
  const draws = new Map<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
  const originals: HTMLCanvasElement[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    draws.clear();
    originals.length = 0;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(520);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(440);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      const fillRect = vi.fn();
      draws.set(this, fillRect);
      return { fillRect, setTransform: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(),
        moveTo: vi.fn(), lineTo: vi.fn(), fill: vi.fn() } as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
      expect(this.isConnected).toBe(false);
      originals.push(this);
      return `data:image/png;base64,original-${originals.length}`;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("publishes complete immutable animation canvases with their actual retained originals", () => {
    const { container, unmount } = render(<ScreenshotQaFixture route="anim" />);
    const first = container.querySelector("canvas")!;
    const firstDrawCount = draws.get(first)!.mock.calls.length;
    expect(originals[0]).toBe(first);
    act(() => { vi.advanceTimersByTime(50); });
    const second = container.querySelector("canvas")!;
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(draws.get(first)!.mock.calls.length).toBe(firstDrawCount);
    expect(originals[1]).toBe(second);
    expect(window.__qaScreenshotSource!.frames).toEqual([
      { id: 0, atMs: expect.any(Number), dataUrl: "data:image/png;base64,original-1" },
      { id: 1, atMs: expect.any(Number), dataUrl: "data:image/png;base64,original-2" },
    ]);
    expect(second.dataset.sourceId).toBe("1");
    unmount();
    act(() => { vi.advanceTimersByTime(100); });
    expect(originals).toHaveLength(2);
    expect(window.__qaScreenshotSource).toBeUndefined();
  });

  it("keeps the full scroll original and reserves the overlay scrollbar gutter", () => {
    const { container } = render(<ScreenshotQaFixture route="scroll" />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(1536);
    expect(window.__qaScreenshotSource).toMatchObject({
      kind: "scroll", cssWidth: 512, cssHeight: 1536, dataUrl: "data:image/png;base64,original-1", frames: [],
    });
    act(() => { vi.advanceTimersByTime(100); });
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(originals).toHaveLength(1);
  });
});
