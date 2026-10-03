import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VNC_TOOLBAR_HIDE_MS, VncFullScreenToolbar } from "./VncFullScreenToolbar";

function renderToolbar() {
  render(
    <VncFullScreenToolbar
      scaledTo100={false}
      viewOnly={false}
      onExitFullScreen={() => {}}
      onToggleScale={() => {}}
      onSendCtrlAltDel={() => {}}
      onOpenMenu={() => {}}
      onEndSession={() => {}}
    />,
  );
  return {
    hotzone: screen.getByTestId("vnc-fullscreen-hotzone"),
    toolbar: screen.getByTestId("vnc-fullscreen-toolbar"),
  };
}

describe("VncFullScreenToolbar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("slides out at the top edge and hides after the pointer leaves the edge", () => {
    const { hotzone, toolbar } = renderToolbar();
    expect(toolbar.dataset.visible).toBe("false");
    fireEvent.pointerEnter(hotzone);
    expect(toolbar.dataset.visible).toBe("true");
    fireEvent.pointerLeave(hotzone);
    act(() => {
      vi.advanceTimersByTime(VNC_TOOLBAR_HIDE_MS - 1);
    });
    expect(toolbar.dataset.visible).toBe("true");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(toolbar.dataset.visible).toBe("false");
  });

  it("stays out while the pointer is on it and when pinned", () => {
    const { hotzone, toolbar } = renderToolbar();
    fireEvent.pointerEnter(hotzone);
    fireEvent.pointerLeave(hotzone);
    fireEvent.pointerEnter(toolbar);
    act(() => {
      vi.advanceTimersByTime(VNC_TOOLBAR_HIDE_MS * 2);
    });
    expect(toolbar.dataset.visible).toBe("true");
    fireEvent.click(screen.getByTestId("vnc-fs-pin"));
    fireEvent.pointerLeave(toolbar);
    act(() => {
      vi.advanceTimersByTime(VNC_TOOLBAR_HIDE_MS * 2);
    });
    expect(toolbar.dataset.visible).toBe("true");
  });
});
