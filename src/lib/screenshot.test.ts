import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => p,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

vi.mock("./runtime", () => ({
  isTauriRuntime: () => false,
}));

import { normalizeRect, toPhysicalRect } from "./screenshot";

describe("normalizeRect", () => {
  it("keeps top-left to bottom-right drags as-is", () => {
    expect(normalizeRect({ x: 10, y: 20 }, { x: 110, y: 120 })).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 100,
    });
  });

  it("normalizes reverse drags to a top-left origin", () => {
    expect(normalizeRect({ x: 110, y: 120 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 100,
    });
  });

  it("handles mixed-direction drags", () => {
    expect(normalizeRect({ x: 110, y: 20 }, { x: 10, y: 120 })).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 100,
    });
  });

  it("produces a zero-size rect for clicks without movement", () => {
    expect(normalizeRect({ x: 50, y: 50 }, { x: 50, y: 50 })).toEqual({
      x: 50,
      y: 50,
      w: 0,
      h: 0,
    });
  });
});

describe("toPhysicalRect", () => {
  it("scales CSS pixels to device pixels", () => {
    expect(toPhysicalRect({ x: 10, y: 20, w: 100, h: 50 }, 2)).toEqual({
      x: 20,
      y: 40,
      width: 200,
      height: 100,
    });
  });

  it("is the identity at scale 1", () => {
    const r = { x: 5, y: 7, w: 11, h: 13 };
    expect(toPhysicalRect(r, 1)).toEqual({ x: 5, y: 7, width: 11, height: 13 });
  });

  it("round-trips with normalizeRect for a real selection", () => {
    const sel = normalizeRect({ x: 300, y: 200 }, { x: 100, y: 50 });
    expect(toPhysicalRect(sel, 1.5)).toEqual({
      x: 150,
      y: 75,
      width: 300,
      height: 225,
    });
  });
});
