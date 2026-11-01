import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWebviewGuards } from "./webviewGuards";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function contextMenu(target: Element | Window) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("shared WebView guards", () => {
  it("suppresses production context menus but preserves editable menus and cleans up", () => {
    vi.stubEnv("PROD", true);
    const input = document.createElement("input");
    document.body.append(input);
    const { unmount } = renderHook(useWebviewGuards);
    expect(contextMenu(document.body).defaultPrevented).toBe(true);
    expect(contextMenu(input).defaultPrevented).toBe(false);
    unmount();
    expect(contextMenu(document.body).defaultPrevented).toBe(false);
    input.remove();
  });

  it("prevents production reload navigation without stopping feature keyboard handlers", () => {
    vi.stubEnv("PROD", true);
    const { unmount } = renderHook(useWebviewGuards);
    const featureHandler = vi.fn();
    window.addEventListener("keydown", featureHandler);
    for (const options of [{ key: "F5" }, { key: "r", ctrlKey: true }, { key: "R", metaKey: true, shiftKey: true }]) {
      const event = new KeyboardEvent("keydown", { ...options, bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(featureHandler).toHaveBeenCalledTimes(3);
    unmount();
    const after = new KeyboardEvent("keydown", { key: "F5", cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    window.removeEventListener("keydown", featureHandler);
  });

  it("blocks OS file navigation in every build but preserves ordinary text drags", () => {
    vi.stubEnv("PROD", false);
    const { unmount } = renderHook(useWebviewGuards);
    const drag = (types: string[]) => {
      const event = new Event("dragover", { cancelable: true });
      const transfer = { types, dropEffect: "none" };
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      window.dispatchEvent(event);
      return { event, transfer };
    };
    const files = drag(["Files"]);
    expect(files.event.defaultPrevented).toBe(true);
    expect(files.transfer.dropEffect).toBe("copy");
    expect(drag(["text/plain"]).event.defaultPrevented).toBe(false);
    unmount();
    expect(drag(["Files"]).event.defaultPrevented).toBe(false);
  });

  it("keeps development reload keys available", () => {
    vi.stubEnv("PROD", false);
    const { unmount } = renderHook(useWebviewGuards);
    const event = new KeyboardEvent("keydown", { key: "F5", cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(contextMenu(document.body).defaultPrevented).toBe(false);
    unmount();
  });
});
