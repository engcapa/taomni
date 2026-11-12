import { afterEach, describe, expect, it, vi } from "vitest";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { dispatchNativeDragDrop, NATIVE_FILE_DRAG_EVENT } from "./nativeFileDrag";
import { NATIVE_FILE_DROP_EVENT } from "./osFileDrop";

afterEach(() => vi.restoreAllMocks());

describe("native drag forwarding", () => {
  it("converts physical hover/drop coordinates but preserves the drop-only event contract", () => {
    const drag = vi.fn();
    const drop = vi.fn();
    window.addEventListener(NATIVE_FILE_DRAG_EVENT, drag);
    window.addEventListener(NATIVE_FILE_DROP_EVENT, drop);
    try {
      const position = new PhysicalPosition(200, 100);
      dispatchNativeDragDrop({ type: "enter", paths: ["/tmp/note.txt"], position }, 2);
      dispatchNativeDragDrop({ type: "over", position }, 2);
      expect(drop).not.toHaveBeenCalled();
      expect(drag.mock.calls.map(([event]) => event.detail)).toEqual([
        { type: "enter", clientX: 100, clientY: 50 }, { type: "over", clientX: 100, clientY: 50 },
      ]);
      dispatchNativeDragDrop({ type: "drop", paths: ["/tmp/note.txt"], position }, 2);
      expect(drop).toHaveBeenCalledTimes(1);
      expect(drop.mock.calls[0][0].detail).toEqual({ paths: ["/tmp/note.txt"], clientX: 100, clientY: 50 });
      expect(drag.mock.calls.at(-1)?.[0].detail).toEqual({ type: "leave" });
      dispatchNativeDragDrop({ type: "leave" }, 2);
      dispatchNativeDragDrop({ type: "drop", paths: [], position }, 2);
      expect(drop).toHaveBeenCalledTimes(1);
      expect(drag.mock.calls.at(-1)?.[0].detail).toEqual({ type: "leave" });
    } finally {
      window.removeEventListener(NATIVE_FILE_DRAG_EVENT, drag);
      window.removeEventListener(NATIVE_FILE_DROP_EVENT, drop);
    }
  });
});
