import { describe, expect, it } from "vitest";
import {
  computeEditorTabScrollState,
  contentRangeFromRects,
  editorTabScrollStep,
  ensureChildVisibleScrollLeft,
  ensureContentRangeVisibleScrollLeft,
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

  it("maps viewport rects into scroll-content coordinates (sidebar-safe)", () => {
    // Container starts at x=300 (left tree pane); child tab is 450px into content.
    const range = contentRangeFromRects(
      {
        scrollLeft: 0,
        getBoundingClientRect: () => ({ left: 300 }),
      },
      {
        getBoundingClientRect: () => ({ left: 750, right: 900 }),
      },
    );
    expect(range).toEqual({ left: 450, right: 600 });

    // With existing scrollLeft, rects already shifted; content coords stay stable.
    const scrolled = contentRangeFromRects(
      {
        scrollLeft: 200,
        getBoundingClientRect: () => ({ left: 300 }),
      },
      {
        getBoundingClientRect: () => ({ left: 550, right: 700 }),
      },
    );
    expect(scrolled).toEqual({ left: 450, right: 600 });
  });

  it("computes scrollLeft to bring an off-screen content range into view", () => {
    expect(ensureContentRangeVisibleScrollLeft(200, 200, 0, 100)).toBe(0);
    expect(ensureContentRangeVisibleScrollLeft(0, 200, 250, 350)).toBe(158);
    expect(ensureContentRangeVisibleScrollLeft(50, 200, 80, 120)).toBe(50);
  });

  it("ensureChildVisibleScrollLeft uses rect geometry, not offsetLeft", () => {
    // Poison offsetLeft as if offsetParent were body (sidebar + content offset).
    const container = {
      scrollLeft: 0,
      clientWidth: 200,
      offsetLeft: 0,
      getBoundingClientRect: () => ({ left: 300, right: 500, width: 200, top: 0, bottom: 28, height: 28, x: 300, y: 0, toJSON: () => ({}) }),
    };
    const child = {
      // Body-relative offsetLeft that would wrongly scroll if trusted:
      offsetLeft: 300 + 750,
      offsetWidth: 150,
      getBoundingClientRect: () => ({
        left: 300 + 750,
        right: 300 + 750 + 150,
        width: 150,
        top: 0,
        bottom: 28,
        height: 28,
        x: 1050,
        y: 0,
        toJSON: () => ({}),
      }),
    };
    // Content left is 750; need scrollLeft = 750+150-200+8 = 708
    expect(ensureChildVisibleScrollLeft(container, child)).toBe(708);
    // If someone used offsetLeft=1050 as content left they would get 1008.
    expect(ensureChildVisibleScrollLeft(container, child)).not.toBe(
      child.offsetLeft + child.offsetWidth - container.clientWidth + 8,
    );
  });
});
