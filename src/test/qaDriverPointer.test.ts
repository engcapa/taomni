import { beforeEach, describe, expect, it, vi } from "vitest";
import pointerScript from "../../src-tauri/src/qa_driver_pointer.js?raw";

type Action = { type: string; x?: number; y?: number; button?: number; value?: string };
type Source = { type: string; actions: Action[] };
type Modifiers = { Control: boolean; Shift: boolean; Alt: boolean; Meta: boolean };
type Dispatch = (
  sources: Source[],
  emitKey: (type: string, value: keyof Modifiers) => void,
  modifiers: Modifiers,
  resolveOrigin: (origin: unknown, x: number, y: number) => [number, number],
  targetAtPoint: (x: number, y: number) => HTMLElement,
) => void;

// Execute the exact JavaScript embedded by the QA-only Rust bridge.
const dispatch = new Function(
  "sources", "emitKey", "modifiers", "resolveOrigin", "targetAtPoint",
  `${pointerScript}\nreturn dispatchQaActions(sources, emitKey, modifiers, resolveOrigin, targetAtPoint);`,
) as Dispatch;

const elementClick = new Function("el", `${pointerScript}\nreturn dispatchQaElementClick(el);`) as (el: HTMLElement) => boolean;

function fixture(sources: Source[]) {
  const root = document.createElement("div");
  const cell = document.createElement("span");
  root.append(cell);
  document.body.append(root);
  const modifiers: Modifiers = { Control: false, Shift: false, Alt: false, Meta: false };
  const events: MouseEvent[] = [];
  for (const type of ["mousedown", "mousemove", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "mouseover"]) {
    root.addEventListener(type, (event) => events.push(event as MouseEvent));
  }
  const run = () => dispatch(sources, (type, key) => {
    modifiers[key] = type === "keyDown";
  }, modifiers, (_origin, x, y) => [x, y], (x) => x < 8 ? root : cell);
  return { root, events, modifiers, run };
}

const drag: Action[] = [
  { type: "pointerMove", x: 4, y: 10 },
  { type: "pointerDown", button: 0 },
  { type: "pointerMove", x: 128, y: 10 },
  { type: "pointerUp", button: 0 },
];

describe("macOS QA WebView pointer actions", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    if (typeof PointerEvent === "undefined") vi.stubGlobal("PointerEvent", MouseEvent);
  });

  it("delivers the compatibility mouse events needed by terminal selection", () => {
    const { events, root, run } = fixture([{ type: "pointer", actions: drag }]);
    root.addEventListener("mousedown", (event) => event.preventDefault());
    run();
    const selectionEvents = events.filter((event) => ["mousedown", "mousemove", "mouseup"].includes(event.type));
    expect(selectionEvents.map((event) => [event.type, event.clientX, event.buttons, event.detail])).toEqual([
      ["mousemove", 4, 0, 0], ["mousedown", 4, 1, 1], ["mousemove", 128, 1, 0], ["mouseup", 128, 0, 1],
    ]);
    expect(events.some((event) => event.type === "click")).toBe(false);
  });

  it("clears an existing xterm selection with a single element click before dragging", () => {
    const { root, events, run } = fixture([{ type: "pointer", actions: drag }]);
    let selected = true;
    // xterm recognises only detail 1/2/3; detail 0 leaves the old selection in place.
    root.addEventListener("mousedown", (event) => {
      if (event.detail === 1) selected = false;
    });
    expect(elementClick(root)).toBe(true);
    expect(selected).toBe(false);
    expect(events.filter((event) => ["mousedown", "mouseup"].includes(event.type))
      .map((event) => [event.type, event.buttons, event.detail])).toEqual([
      ["mousedown", 1, 1], ["mouseup", 0, 1],
    ]);
    run();
    expect(events.filter((event) => event.type === "click")).toHaveLength(1);
  });

  it("retains element focus and suppresses mouse events for pointer-only surfaces", () => {
    const { root, events } = fixture([]);
    root.tabIndex = 0;
    root.addEventListener("pointerdown", (event) => event.preventDefault());
    elementClick(root);
    expect(document.activeElement).toBe(root);
    expect(events.some((event) => event.type === "mousedown" || event.type === "mouseup")).toBe(false);
    expect(events.filter((event) => event.type === "click")).toHaveLength(1);
  });

  it("holds Control and Shift throughout a block drag and releases them after it", () => {
    const { events, modifiers, run } = fixture([
      { type: "key", actions: [
        { type: "keyDown", value: "Control" }, { type: "keyDown", value: "Shift" },
        ...drag.map(() => ({ type: "pause" })),
        { type: "keyUp", value: "Shift" }, { type: "keyUp", value: "Control" },
      ] },
      { type: "pointer", actions: [{ type: "pause" }, { type: "pause" }, ...drag, { type: "pause" }, { type: "pause" }] },
    ]);
    run();
    expect(events.filter((event) => ["mousedown", "mousemove", "mouseup"].includes(event.type))
      .every((event) => event.ctrlKey && event.shiftKey)).toBe(true);
    expect(modifiers).toEqual({ Control: false, Shift: false, Alt: false, Meta: false });
  });

  it("retains hover, click and double-click behavior", () => {
    const { events, run } = fixture([{ type: "pointer", actions: [
      { type: "pointerMove", x: 20, y: 10 },
      { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 },
      { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 },
    ] }]);
    run();
    expect(events.filter((event) => event.type === "mouseover")).toHaveLength(1);
    expect(events.filter((event) => event.type === "click")).toHaveLength(2);
    expect(events.filter((event) => event.type === "dblclick")).toHaveLength(1);
  });

  it("uses the right-button mask and opens the context menu", () => {
    const { events, run } = fixture([{ type: "pointer", actions: [
      { type: "pointerMove", x: 20, y: 10 },
      { type: "pointerDown", button: 2 }, { type: "pointerUp", button: 2 },
    ] }]);
    run();
    expect(events.find((event) => event.type === "mousedown")?.buttons).toBe(2);
    expect(events.filter((event) => event.type === "contextmenu")).toHaveLength(1);
    expect(events.some((event) => event.type === "click")).toBe(false);
  });

  it("uses the middle-button mask and emits auxclick", () => {
    const { events, run } = fixture([{ type: "pointer", actions: [
      { type: "pointerMove", x: 20, y: 10 },
      { type: "pointerDown", button: 1 }, { type: "pointerUp", button: 1 },
    ] }]);
    run();
    expect(events.find((event) => event.type === "mousedown")?.buttons).toBe(4);
    expect(events.filter((event) => event.type === "auxclick")).toHaveLength(1);
    expect(events.some((event) => event.type === "click")).toBe(false);
  });

  it("suppresses compatibility mouse events when pointerdown is canceled", () => {
    const { root, events, run } = fixture([{ type: "pointer", actions: drag }]);
    root.addEventListener("pointerdown", (event) => event.preventDefault());
    run();
    expect(events.some((event) => event.type === "mousedown" || event.type === "mouseup")).toBe(false);
  });
});
