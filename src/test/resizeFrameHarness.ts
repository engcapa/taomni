import { vi } from "vitest";

/** Deliberately keep RO delivery separate from animation-frame layout work. */
export function resizeFrameHarness() {
  const frames = new Map<number, FrameRequestCallback>();
  const observers: { notify(): void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn();
    constructor(notify: () => void) { observers.push({ notify, disconnect: this.disconnect }); }
    observe() {}
  });
  return {
    frames, observers,
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    },
  };
}
