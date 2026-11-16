import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealSettingsSection } from "./sectionReveal";

describe("Settings section reveal ownership", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let resize: () => void;
  let disconnect: ReturnType<typeof vi.fn>;
  let observe: ReturnType<typeof vi.fn>;
  let panel: HTMLDivElement;
  let content: HTMLElement;
  let anchor: HTMLElement;
  let anchorTop: number;
  let scroll: ReturnType<typeof vi.fn<HTMLElement["scrollIntoView"]>>;
  let dispose: (() => void) | undefined;
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    disconnect = vi.fn();
    observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    panel = document.createElement("div");
    panel.dataset.testid = "settings-panel";
    content = document.createElement("main");
    anchor = document.createElement("section");
    anchor.style.scrollMarginTop = "72px";
    content.append(anchor);
    panel.append(content);
    document.body.append(panel);
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 600 });
    panel.getBoundingClientRect = () => new DOMRect(0, 40, 800, 600);
    anchorTop = 900;
    anchor.getBoundingClientRect = () => new DOMRect(0, anchorTop, 800, 1200);
    scroll = vi.fn<HTMLElement["scrollIntoView"]>(() => { anchorTop = 112; });
    anchor.scrollIntoView = scroll;
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    panel.remove();
    vi.unstubAllGlobals();
  });

  const start = (maintainLayout = true) => {
    const onReveal = vi.fn();
    dispose = revealSettingsSection({ resolveAnchor: () => anchor, onReveal, maintainLayout });
    flush();
    return onReveal;
  };

  it("recovers the heading when asynchronous content grows above an already revealed section", () => {
    const onReveal = start();
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    expect(observe.mock.calls.map(([element]) => element)).toEqual([panel, content]);
    resize();
    flush();
    expect(scroll).toHaveBeenCalledTimes(1);

    // Model cards arriving above Tao move its heading but not its own size.
    anchorTop = 2100;
    resize();
    resize();
    expect(frames.size).toBe(1);
    flush();
    expect(anchorTop).toBe(112);
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it.each(["wheel", "pointerdown", "touchstart", "keydown"])("lets %s take over without jumping back on later layout changes", (event) => {
    start();
    window.dispatchEvent(new Event(event));
    anchorTop = -500;
    resize();
    flush();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(anchorTop).toBe(-500);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("waits for collapsed group content and cancels pending work on disposal", () => {
    content.hidden = true;
    start();
    expect(scroll).not.toHaveBeenCalled();
    content.hidden = false;
    flush();
    expect(scroll).toHaveBeenCalledTimes(1);
    anchorTop = 1500;
    resize();
    dispose?.();
    flush();
    resize();
    flush();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("leaves a requested preset row in control after the initial section reveal", () => {
    start(false);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
    anchorTop = 1400;
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("ignores a hidden tab and resumes layout protection when its viewport reappears", () => {
    start();
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 0 });
    anchorTop = 1700;
    resize();
    flush();
    expect(scroll).toHaveBeenCalledTimes(1);
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 600 });
    resize();
    flush();
    expect(scroll).toHaveBeenCalledTimes(2);
  });
});
