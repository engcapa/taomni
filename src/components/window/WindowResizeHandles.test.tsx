import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const windowState = vi.hoisted(() => ({
  fullscreen: false,
  maximized: false,
  resized: null as null | (() => void),
}));

vi.mock("../../lib/runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: async () => windowState.fullscreen,
    isMaximized: async () => windowState.maximized,
    onResized: async (handler: () => void) => {
      windowState.resized = handler;
      return () => {
        windowState.resized = null;
      };
    },
    startResizeDragging: async () => {},
  }),
}));

import { WindowResizeHandles } from "./WindowResizeHandles";

describe("WindowResizeHandles", () => {
  afterEach(() => {
    cleanup();
    windowState.fullscreen = false;
    windowState.maximized = false;
  });

  it("removes the edge handles while the window is full screen and restores them after", async () => {
    const { container } = render(<WindowResizeHandles />);
    await act(async () => {});
    expect(container.querySelectorAll("div.absolute")).toHaveLength(8);

    windowState.fullscreen = true;
    await act(async () => {
      windowState.resized?.();
    });
    expect(container.querySelectorAll("div.absolute")).toHaveLength(0);

    windowState.fullscreen = false;
    await act(async () => {
      windowState.resized?.();
    });
    expect(container.querySelectorAll("div.absolute")).toHaveLength(8);
  });

  it("has no handles on a maximized window", async () => {
    windowState.maximized = true;
    const { container } = render(<WindowResizeHandles />);
    await act(async () => {});
    expect(container.querySelectorAll("div.absolute")).toHaveLength(0);
  });

  it("reserves the main window top frame for moving while retaining edge and corner resize targets", async () => {
    const { container } = render(<WindowResizeHandles topEdgeSize={2} />);
    await act(async () => {});
    const handles = [...container.querySelectorAll<HTMLElement>("div.absolute")];
    expect(handles[0]).toHaveStyle({ height: "2px" });
    expect(handles[1]).toHaveStyle({ height: "6px" });
    expect(handles[2]).toHaveStyle({ width: "6px" });
    for (const corner of handles.slice(4)) expect(corner).toHaveStyle({ width: "14px", height: "14px" });
  });
});
