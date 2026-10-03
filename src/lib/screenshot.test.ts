import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

vi.mock("./runtime", () => ({
  isTauriRuntime: () => false,
}));

import {
  acceleratorFromEvent,
  eventMatchesAccelerator,
  formatAccelerator,
  loadScreenshotUrl,
  normalizeRect,
  toPhysicalRect,
} from "./screenshot";

const key = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("normalizeRect", () => {
  it("keeps top-left to bottom-right drags as-is", () => {
    expect(normalizeRect({ x: 10, y: 20 }, { x: 110, y: 120 })).toEqual({ x: 10, y: 20, w: 100, h: 100 });
  });

  it("normalizes reverse drags to a top-left origin", () => {
    expect(normalizeRect({ x: 110, y: 120 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 100, h: 100 });
  });

  it("handles zero-size drags", () => {
    expect(normalizeRect({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, w: 0, h: 0 });
  });
});

describe("toPhysicalRect", () => {
  it("scales CSS px to integral physical px", () => {
    expect(toPhysicalRect({ x: 10, y: 20, w: 100, h: 50 }, 2)).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });

  it("rounds edges, not sizes, so adjacent regions tile exactly", () => {
    // 1.5x: edges 15.15 -> 15 and 165.15 -> 165, size 150.
    expect(toPhysicalRect({ x: 10.1, y: 0, w: 100, h: 10 }, 1.5)).toEqual({ x: 15, y: 0, width: 150, height: 15 });
  });

  it("scales axes independently", () => {
    expect(toPhysicalRect({ x: 10, y: 10, w: 10, h: 10 }, 2, 1.5)).toEqual({ x: 20, y: 15, width: 20, height: 15 });
  });

  it("clamps to the image bounds", () => {
    expect(toPhysicalRect({ x: 390, y: 290, w: 50, h: 50 }, 1, 1, { width: 400, height: 300 })).toEqual({
      x: 390,
      y: 290,
      width: 10,
      height: 10,
    });
  });

  it("never returns an empty rect", () => {
    expect(toPhysicalRect({ x: 0, y: 0, w: 0, h: 0 }, 1)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("accelerators", () => {
  it("formats per platform", () => {
    expect(formatAccelerator("Control+Alt+A", false)).toBe("Ctrl+Alt+A");
    expect(formatAccelerator("Control+Super+KeyA", true)).toBe("⌃⌘A");
    expect(formatAccelerator("Shift+F1", false)).toBe("Shift+F1");
    expect(formatAccelerator("", false)).toBe("");
  });

  it("builds an accelerator from a key event", () => {
    expect(acceleratorFromEvent(key("KeyA", { ctrlKey: true, altKey: true }))).toBe("Control+Alt+KeyA");
    expect(acceleratorFromEvent(key("F2", { shiftKey: true }))).toBe("Shift+F2");
    expect(acceleratorFromEvent(key("ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(acceleratorFromEvent(key("AltRight", { altKey: true }))).toBeNull();
  });

  it("matches events exactly, modifiers included", () => {
    expect(eventMatchesAccelerator(key("KeyA", { ctrlKey: true, altKey: true }), "Control+Alt+A")).toBe(true);
    expect(eventMatchesAccelerator(key("KeyA", { ctrlKey: true, altKey: true }), "Control+Alt+KeyA")).toBe(true);
    // Extra Shift: Ctrl+Shift+Alt+A must not trigger Ctrl+Alt+A.
    expect(eventMatchesAccelerator(key("KeyA", { ctrlKey: true, altKey: true, shiftKey: true }), "Control+Alt+A")).toBe(false);
    // Ctrl+Shift+A (Find Action) never matches the default chord.
    expect(eventMatchesAccelerator(key("KeyA", { ctrlKey: true, shiftKey: true }), "Control+Alt+A")).toBe(false);
    expect(eventMatchesAccelerator(key("KeyA", { ctrlKey: true, metaKey: true }), "Control+Super+A")).toBe(true);
    expect(eventMatchesAccelerator(key("Digit1", { altKey: true }), "Alt+1")).toBe(true);
    expect(eventMatchesAccelerator(key("KeyA", { ctrlKey: true, altKey: true }), "")).toBe(false);
  });

  it("round-trips recorded chords through the matcher", () => {
    const event = key("KeyQ", { ctrlKey: true, shiftKey: true });
    const accelerator = acceleratorFromEvent(event);
    expect(accelerator).not.toBeNull();
    expect(eventMatchesAccelerator(event, accelerator!)).toBe(true);
  });
});

describe("loadScreenshotUrl", () => {
  it("passes data URLs through in browser mode", async () => {
    await expect(loadScreenshotUrl("data:image/png;base64,AAA")).resolves.toBe("data:image/png;base64,AAA");
  });
});
