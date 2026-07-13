import { describe, expect, it } from "vitest";
import {
  computeEditorTabScrollState,
  editorTabScrollStep,
  ensureChildVisibleScrollLeft,
  maxScrollLeft,
} from "./editorTabScroll";

describe("editorTabScroll", () => {
  it("detects overflow and edge positions from scroll metrics", () => {
    expect(maxScrollLeft({ scrollWidth: 1000, clientWidth: 300 })).toBe(700);
    expect(computeEditorTabScrollState({
      scrollLeft: 0,
      scrollWidth: 1000,
      clientWidth: 300,
    })).toEqual({ overflow: true, atStart: true, atEnd: false });
    expect(computeEditorTabScrollState({
      scrollLeft: 350,
      scrollWidth: 1000,
      clientWidth: 300,
    })).toEqual({ overflow: true, atStart: false, atEnd: false });
    expect(computeEditorTabScrollState({
      scrollLeft: 700,
      scrollWidth: 1000,
      clientWidth: 300,
    })).toEqual({ overflow: true, atStart: false, atEnd: true });
    expect(computeEditorTabScrollState({
      scrollLeft: 0,
      scrollWidth: 300,
      clientWidth: 300,
    })).toEqual({ overflow: false, atStart: true, atEnd: true });
  });

  it("steps by at least the minimum and mostly one viewport width", () => {
    expect(editorTabScrollStep(100)).toBe(160);
    expect(editorTabScrollStep(400)).toBe(320);
  });

  it("computes scrollLeft to bring an off-screen child into view", () => {
    // Child left of viewport
    expect(ensureChildVisibleScrollLeft(
      { scrollLeft: 200, clientWidth: 200 },
      { offsetLeft: 0, offsetWidth: 100 },
    )).toBe(0);
    // Child right of viewport
    expect(ensureChildVisibleScrollLeft(
      { scrollLeft: 0, clientWidth: 200 },
      { offsetLeft: 250, offsetWidth: 100 },
    )).toBe(158); // 350 - 200 + 8
    // Already visible — unchanged
    expect(ensureChildVisibleScrollLeft(
      { scrollLeft: 50, clientWidth: 200 },
      { offsetLeft: 80, offsetWidth: 40 },
    )).toBe(50);
  });
});
