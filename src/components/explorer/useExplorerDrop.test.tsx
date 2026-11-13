import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveCustomDragData, isCustomDragActive, startCustomDrag } from "../../lib/customDnD";
import { useExplorerDrop, EXPLORER_DRAG_MIME } from "./useExplorerDrop";
import type { ExplorerOperations } from "./useExplorerOperations";

const drop = vi.fn(async () => {});
function pointer(target: Window | Document | Node | Element, type: string, init: MouseEventInit) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}
function Harness() {
  const root = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const dropPath = useExplorerDrop(root, { drop, busy: false } as unknown as ExplorerOperations);
  return <div ref={root}>
    <div data-testid="source" onPointerDown={(event) => startCustomDrag({
      event,
      data: { mime: EXPLORER_DRAG_MIME, payload: { paths: ["/target/folder/nested/drag-source.txt"] } },
      ghostText: "drag-source.txt",
    })}><span>drag-source.txt</span></div>
    <nav>
      <div data-explorer-drop="/source"><button data-testid="expand" onClick={() => setExpanded((value) => !value)}>Expand</button></div>
      {expanded && <div data-testid="tree-target" data-explorer-drop="/source/folder" data-drop-active={dropPath === "/source/folder"}><svg><path data-testid="tree-target-icon" /></svg>folder</div>}
    </nav>
  </div>;
}
let hit: Element | null;
beforeEach(() => {
  drop.mockClear(); hit = null;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => hit) });
});
afterEach(() => {
  fireEvent.keyDown(window, { key: "Escape" });
  pointer(window, "pointerup", { button: 0 });
  cleanup(); vi.restoreAllMocks();
});

describe("Explorer real custom pointer drop routing", () => {
  it("drops a selected file onto a newly expanded navigation-tree folder icon", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("expand"));
    hit = screen.getByTestId("tree-target-icon");
    const expand = screen.getByTestId("expand");
    expand.focus();
    pointer(screen.getByTestId("source"), "pointerdown", { button: 0, clientX: 826, clientY: 155 });
    // The browser's mousedown default action transfers focus after pointerdown.
    // A captured descendant blur is not an application-window blur.
    fireEvent.blur(expand);
    expect(getActiveCustomDragData()?.mime).toBe(EXPLORER_DRAG_MIME);
    pointer(window, "pointermove", { buttons: 1, clientX: 413.5, clientY: 521.06 });
    expect(isCustomDragActive()).toBe(true);
    expect(screen.getByTestId("tree-target")).toHaveAttribute("data-drop-active", "true");
    pointer(window, "pointerup", { button: 0, clientX: 413.5, clientY: 521.06 });
    expect(drop).toHaveBeenCalledWith(["/target/folder/nested/drag-source.txt"], "/source/folder", false);
  });

  it("still cancels an active drag when the actual application window loses focus", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("expand"));
    hit = screen.getByTestId("tree-target-icon");
    pointer(screen.getByTestId("source"), "pointerdown", { button: 0, clientX: 826, clientY: 155 });
    pointer(window, "pointermove", { buttons: 1, clientX: 413.5, clientY: 521.06 });
    expect(isCustomDragActive()).toBe(true);
    fireEvent.blur(window);
    expect(isCustomDragActive()).toBe(false);
    pointer(window, "pointerup", { button: 0, clientX: 413.5, clientY: 521.06 });
    expect(drop).not.toHaveBeenCalled();
  });

  it("retains the live target registration when expansion updates React during an armed drag", () => {
    render(<Harness />);
    pointer(screen.getByTestId("source"), "pointerdown", { button: 0, clientX: 826, clientY: 155 });
    fireEvent.click(screen.getByTestId("expand"));
    hit = screen.getByTestId("tree-target-icon");
    pointer(window, "pointermove", { buttons: 1, clientX: 413.5, clientY: 521.06, ctrlKey: true });
    pointer(window, "pointerup", { button: 0, clientX: 413.5, clientY: 521.06, ctrlKey: true });
    expect(drop).toHaveBeenCalledWith(["/target/folder/nested/drag-source.txt"], "/source/folder", true);
  });
});
