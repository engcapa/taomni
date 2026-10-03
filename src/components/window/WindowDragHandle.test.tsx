import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowDragHandle } from "./WindowDragHandle";

const windowMocks = vi.hoisted(() => ({
  startDragging: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowMocks }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WindowDragHandle", () => {
  it("moves the window once for a primary press and ignores other mouse buttons", () => {
    const bubbled = vi.fn();
    render(<div onMouseDown={bubbled}><WindowDragHandle /></div>);
    const handle = screen.getByTestId("window-drag-handle");
    fireEvent.mouseDown(handle, { button: 0, detail: 1 });
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
    expect(bubbled).not.toHaveBeenCalled();
    fireEvent.mouseDown(handle, { button: 1, detail: 1 });
    fireEvent.mouseDown(handle, { button: 2, detail: 1 });
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
    expect(windowMocks.toggleMaximize).not.toHaveBeenCalled();
  });

  it("keeps the native double-click maximize gesture", () => {
    render(<WindowDragHandle />);
    fireEvent.mouseDown(screen.getByTestId("window-drag-handle"), { button: 0, detail: 2 });
    expect(windowMocks.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(windowMocks.startDragging).not.toHaveBeenCalled();
  });
});
