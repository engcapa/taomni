import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import {
  closeHoverDoc,
  hoverDocField,
  hoverDocHideGraceMs,
  hoverDocTooltip,
  isMovingTowardsRect,
  openHoverDoc,
  pointInRect,
} from "./hoverDocTooltip";

const popup = { left: 100, top: 40, right: 400, bottom: 200 };

describe("isMovingTowardsRect (IDEA MouseMovementTracker.isMovingTowards)", () => {
  it("accepts a move whose direction points into the popup", () => {
    // Hovered word below the popup; moving straight up and diagonally up-right.
    expect(isMovingTowardsRect({ x: 150, y: 240 }, { x: 150, y: 230 }, popup)).toBe(true);
    expect(isMovingTowardsRect({ x: 60, y: 260 }, { x: 70, y: 250 }, popup)).toBe(true);
  });

  it("rejects moves away from or beside the popup", () => {
    expect(isMovingTowardsRect({ x: 150, y: 230 }, { x: 150, y: 240 }, popup)).toBe(false);
    expect(isMovingTowardsRect({ x: 90, y: 230 }, { x: 80, y: 230 }, popup)).toBe(false);
    expect(isMovingTowardsRect({ x: 450, y: 250 }, { x: 460, y: 240 }, popup)).toBe(false);
  });

  it("treats a pointer inside the popup (with margin) as heading there, and a still pointer as not moving", () => {
    expect(isMovingTowardsRect(null, { x: 200, y: 100 }, popup)).toBe(true);
    expect(isMovingTowardsRect(null, { x: 98, y: 100 }, popup)).toBe(true);
    expect(isMovingTowardsRect({ x: 150, y: 260 }, { x: 150, y: 260 }, popup)).toBe(false);
    expect(pointInRect({ x: 405, y: 100 }, popup)).toBe(false);
  });

  it("derives the hide grace from the hover delay within IDEA-like bounds", () => {
    expect(hoverDocHideGraceMs(300)).toBe(300);
    expect(hoverDocHideGraceMs(50)).toBe(150);
    expect(hoverDocHideGraceMs(1500)).toBe(500);
  });
});

describe("hoverDocTooltip state", () => {
  const views: EditorView[] = [];
  afterEach(() => {
    while (views.length) views.pop()?.destroy();
  });

  function makeView() {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "String value = name;",
        extensions: [hoverDocTooltip({ hoverTime: 300, source: async () => null })],
      }),
      parent,
    });
    views.push(view);
    return view;
  }

  function open(view: EditorView) {
    openHoverDoc(view, 0, 6, () => {
      const dom = document.createElement("div");
      dom.setAttribute("data-testid", "hover-doc-under-test");
      return { dom };
    });
  }

  it("opens and closes through the state field", () => {
    const view = makeView();
    open(view);
    expect(view.state.field(hoverDocField)).toMatchObject({ from: 0, to: 6 });
    expect(closeHoverDoc(view)).toBe(true);
    expect(view.state.field(hoverDocField)).toBeNull();
    expect(closeHoverDoc(view)).toBe(false);
  });

  it("closes on typing or a selection change (hideOnChange)", () => {
    const view = makeView();
    open(view);
    view.dispatch({ changes: { from: 20, insert: "x" } });
    expect(view.state.field(hoverDocField)).toBeNull();
    open(view);
    view.dispatch({ selection: { anchor: 3 } });
    expect(view.state.field(hoverDocField)).toBeNull();
  });

  it("closes on Escape in the editor before other Escape handlers", () => {
    const view = makeView();
    open(view);
    const handled = runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Escape" }), "editor");
    expect(handled).toBe(true);
    expect(view.state.field(hoverDocField)).toBeNull();
    // Without a popup Escape falls through.
    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Escape" }), "editor")).toBe(false);
  });
});
