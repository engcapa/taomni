import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECTION_BAR_REVEAL_MS, RdpConnectionBar } from "./RdpConnectionBar";
import { ctrlAltDelSequence, rdpNetworkQuality } from "../../lib/rdp";

function renderBar(overrides: Partial<Parameters<typeof RdpConnectionBar>[0]> = {}) {
  const handlers = {
    onCtrlAltDel: vi.fn(),
    onMinimize: vi.fn(),
    onRestore: vi.fn(),
    onDisconnect: vi.fn(),
  };
  const props = {
    title: "build-host",
    network: null,
    revealSignal: 0,
    ...handlers,
    ...overrides,
  };
  const view = render(<RdpConnectionBar {...props} />);
  return { ...handlers, props, view };
}

const bar = () => screen.getByTestId("rdp-connection-bar");

describe("RdpConnectionBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows on connect, hides after the reveal time and returns from the top edge", () => {
    renderBar();
    expect(bar().dataset.visible).toBe("true");
    act(() => vi.advanceTimersByTime(CONNECTION_BAR_REVEAL_MS + 10));
    expect(bar().dataset.visible).toBe("false");

    fireEvent.pointerEnter(screen.getByTestId("rdp-bar-hotzone"));
    expect(bar().dataset.visible).toBe("true");
    act(() => vi.advanceTimersByTime(CONNECTION_BAR_REVEAL_MS + 10));
    expect(bar().dataset.visible).toBe("false");

    // A plain mouse move over the edge reveals it too.
    fireEvent.mouseMove(screen.getByTestId("rdp-bar-hotzone"));
    expect(bar().dataset.visible).toBe("true");
    act(() => vi.advanceTimersByTime(CONNECTION_BAR_REVEAL_MS + 10));
    expect(bar().dataset.visible).toBe("false");

    // So does pointing at the hidden bar's edge with mouse events only.
    fireEvent.mouseOver(bar());
    expect(bar().dataset.visible).toBe("true");
    fireEvent.mouseOut(bar());
    act(() => vi.advanceTimersByTime(CONNECTION_BAR_REVEAL_MS + 10));
    expect(bar().dataset.visible).toBe("false");
  });

  it("reappears when the reveal signal changes (Ctrl+Alt+Home)", () => {
    const { props, view } = renderBar();
    act(() => vi.advanceTimersByTime(CONNECTION_BAR_REVEAL_MS + 10));
    expect(bar().dataset.visible).toBe("false");
    view.rerender(<RdpConnectionBar {...props} revealSignal={1} />);
    expect(bar().dataset.visible).toBe("true");
  });

  it("stays while pinned and remembers the pin", () => {
    renderBar();
    fireEvent.click(screen.getByTestId("rdp-bar-pin"));
    expect(screen.getByTestId("rdp-bar-pin").getAttribute("aria-pressed")).toBe("true");
    act(() => vi.advanceTimersByTime(CONNECTION_BAR_REVEAL_MS * 3));
    expect(bar().dataset.visible).toBe("true");
    expect(localStorage.getItem("taomni.rdp.connectionBar.pinned")).toBe("1");

    cleanup();
    renderBar();
    expect(bar().dataset.pinned).toBe("true");
  });

  it("stays visible while a button has keyboard focus", () => {
    renderBar();
    act(() => screen.getByTestId("rdp-bar-restore").focus());
    act(() => vi.advanceTimersByTime(CONNECTION_BAR_REVEAL_MS * 2));
    expect(bar().dataset.visible).toBe("true");
  });

  it("routes every button and labels them for assistive technology", () => {
    const handlers = renderBar();
    fireEvent.click(screen.getByTestId("rdp-bar-ctrl-alt-del"));
    fireEvent.click(screen.getByTestId("rdp-bar-minimize"));
    fireEvent.click(screen.getByTestId("rdp-bar-restore"));
    fireEvent.click(screen.getByTestId("rdp-bar-disconnect"));
    expect(handlers.onCtrlAltDel).toHaveBeenCalledTimes(1);
    expect(handlers.onMinimize).toHaveBeenCalledTimes(1);
    expect(handlers.onRestore).toHaveBeenCalledTimes(1);
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("aria-label")).toBeTruthy();
    }
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("rdp-bar-title").textContent).toBe("build-host");
  });

  it("maps the server network characteristics to quality bars", () => {
    renderBar({ network: { baseRttMs: 2, averageRttMs: 12, bandwidthKbps: null } });
    const quality = screen.getByTestId("rdp-bar-quality");
    expect(quality.dataset.level).toBe("4");
    expect(quality.getAttribute("aria-label")).toContain("12 ms");
  });
});

describe("rdp connection helpers", () => {
  it("grades RTT and caps by bandwidth when measured", () => {
    expect(rdpNetworkQuality(null)).toBe(0);
    expect(rdpNetworkQuality({ baseRttMs: 1, averageRttMs: 20, bandwidthKbps: null })).toBe(4);
    expect(rdpNetworkQuality({ baseRttMs: 1, averageRttMs: 60, bandwidthKbps: null })).toBe(3);
    expect(rdpNetworkQuality({ baseRttMs: 1, averageRttMs: 120, bandwidthKbps: null })).toBe(2);
    expect(rdpNetworkQuality({ baseRttMs: 1, averageRttMs: 400, bandwidthKbps: null })).toBe(1);
    expect(rdpNetworkQuality({ baseRttMs: 1, averageRttMs: 20, bandwidthKbps: 900 })).toBe(2);
  });

  it("sends Ctrl+Alt+Del as press and release with an extended Delete", () => {
    expect(ctrlAltDelSequence()).toEqual([
      [true, 0x1d],
      [true, 0x38],
      [true, 0x153],
      [false, 0x153],
      [false, 0x38],
      [false, 0x1d],
    ]);
  });
});
