import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeMarqueeDuration, OverviewTitle } from "./OverviewTitle";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setupMockObserver() {
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
    unobserve() {}
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return () => callbacks.forEach((cb) => cb([], {} as ResizeObserver));
}

function attachGeometry(dimensions: { viewportWidth: number; textWidth: number }) {
  const titleEl = screen.getByTestId("tab-overview-card-title");
  const trackEl = titleEl.querySelector(".taomni-overview-title-track") as HTMLElement;
  const textEl = titleEl.querySelector(".taomni-overview-title-text") as HTMLElement;

  Object.defineProperty(titleEl, "clientWidth", { configurable: true, get: () => dimensions.viewportWidth });
  titleEl.getBoundingClientRect = () => ({ width: dimensions.viewportWidth } as DOMRect);
  Object.defineProperty(trackEl, "clientWidth", { configurable: true, get: () => dimensions.viewportWidth });
  Object.defineProperty(trackEl, "scrollWidth", {
    configurable: true,
    get: () => Math.max(dimensions.viewportWidth, dimensions.textWidth),
  });
  Object.defineProperty(textEl, "scrollWidth", { configurable: true, get: () => dimensions.textWidth });
  textEl.getBoundingClientRect = () => ({ width: dimensions.textWidth } as DOMRect);

  return { titleEl, trackEl };
}

describe("OverviewTitle", () => {
  it("computes minimum and length-scaled marquee durations", () => {
    expect(computeMarqueeDuration(80)).toBe(4.5);
    expect(computeMarqueeDuration(400)).toBe(10.9);
  });

  it("keeps short titles static and activates marquee only when overflowing", () => {
    const triggerResize = setupMockObserver();
    const dims = { viewportWidth: 260, textWidth: 140 };
    const { rerender } = render(<OverviewTitle title="short-title.ts" />);
    const { titleEl, trackEl } = attachGeometry(dims);

    rerender(<OverviewTitle title="short-title.ts-v2" />);
    expect(titleEl).not.toHaveAttribute("data-overflowing");
    expect(trackEl).not.toHaveAttribute("data-marquee");
    expect(titleEl).toHaveAttribute("title", "short-title.ts-v2");
    expect(titleEl.textContent).toBe("short-title.ts-v2");

    dims.textWidth = 380;
    rerender(<OverviewTitle title="extremely-long-overview-session-title-that-overflows" />);
    expect(titleEl).toHaveAttribute("data-overflowing", "true");
    expect(trackEl).toHaveAttribute("data-marquee", "extremely-long-overview-session-title-that-overflows");
    expect(trackEl.style.getPropertyValue("--taomni-marquee-duration")).toBe("10.4s");
    expect(titleEl.textContent).toBe("extremely-long-overview-session-title-that-overflows");

    dims.viewportWidth = 420;
    act(() => triggerResize());
    expect(titleEl).not.toHaveAttribute("data-overflowing");
    expect(trackEl).not.toHaveAttribute("data-marquee");

    dims.viewportWidth = 220;
    act(() => triggerResize());
    expect(titleEl).toHaveAttribute("data-overflowing", "true");
    expect(trackEl).toHaveAttribute("data-marquee", "extremely-long-overview-session-title-that-overflows");

    dims.textWidth = 90;
    rerender(<OverviewTitle title="README.md" />);
    expect(titleEl).not.toHaveAttribute("data-overflowing");
    expect(trackEl).not.toHaveAttribute("data-marquee");
  });
});
