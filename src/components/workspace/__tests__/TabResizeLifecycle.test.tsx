import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { useWorkspaceTabScroll } from "../useWorkspaceTabScroll";
import { useEditorGroupTabs, type UseEditorGroupTabsContext } from "../../editor/workspace/group/useEditorGroupTabs";

const editorActions = {
  onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseAll: vi.fn(), onCloseUnmodified: vi.fn(),
  onCloseRight: vi.fn(), onCopyPath: vi.fn(), onSplitRight: vi.fn(), onSplitDown: vi.fn(),
  onMoveTabToNextSplit: undefined, onMoveTabToPreviousSplit: undefined,
  onPin: vi.fn(), onRevealInTree: vi.fn(), onRevealInSystem: vi.fn(),
  onOpenInTerminal: vi.fn(), onLocalHistory: undefined,
} satisfies Partial<UseEditorGroupTabsContext>;
const openOrder = ["a", "b"];

function Strip({ elementRef, overflow, atEnd, setTabElement }: {
  elementRef: RefObject<HTMLDivElement | null>;
  overflow: boolean;
  atEnd: boolean;
  setTabElement?: (key: string, node: HTMLDivElement | null) => void;
}) {
  return <>
    <output data-testid="overflow">{String(overflow)}</output>
    <output data-testid="at-end">{String(atEnd)}</output>
    <div ref={elementRef} data-testid="strip">
      {openOrder.map((key) => <div key={key} data-testid={`tab-${key}`} data-editor-tab-key={key}
        ref={(node) => setTabElement?.(key, node)}>{key}</div>)}
    </div>
  </>;
}

function WorkspaceStrip({ activeKey }: { activeKey: string }) {
  const { scrollRef, scrollState, setTabElement } = useWorkspaceTabScroll("workspace", undefined, activeKey);
  return <Strip elementRef={scrollRef} {...scrollState} setTabElement={setTabElement} />;
}

function EditorStrip({ activeKey }: { activeKey: string }) {
  const { tabScrollRef, tabScrollState } = useEditorGroupTabs({
    openOrder, openFiles: {}, pinnedKeys: [], previewKey: null,
    lastUsedByKey: undefined, tabPolicy: undefined, activeKey, ...editorActions,
  });
  return <Strip elementRef={tabScrollRef} {...tabScrollState} />;
}

function resizeHarness() {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const observers: Array<{ deliver: () => void; connected: boolean }> = [];
  vi.stubGlobal("ResizeObserver", class {
    record: typeof observers[number];
    constructor(callback: ResizeObserverCallback) {
      this.record = { deliver: () => callback([], this as unknown as ResizeObserver), connected: true };
      observers.push(this.record);
    }
    observe() {}
    disconnect() { this.record.connected = false; }
  });
  return {
    frames, observers,
    deliver: () => observers.filter((observer) => observer.connected).forEach((observer) => observer.deliver()),
    flush: () => {
      const scheduled = [...frames.values()];
      frames.clear();
      scheduled.forEach((callback) => callback(0));
    },
  };
}

function geometry() {
  const strip = screen.getByTestId("strip");
  let width = 0;
  let scrollLeft = 0;
  const readWidth = vi.fn(() => width);
  Object.defineProperty(strip, "clientWidth", { configurable: true, get: readWidth });
  Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => width > 0 ? 1200 : 0 });
  Object.defineProperty(strip, "scrollLeft", {
    configurable: true, get: () => scrollLeft, set: (value: number) => { scrollLeft = value; },
  });
  const scrollTo = vi.fn();
  Object.defineProperty(strip, "scrollTo", { configurable: true, value: scrollTo });
  vi.spyOn(strip, "getBoundingClientRect").mockImplementation(() => ({ left: 200 } as DOMRect));
  for (const [key, left] of [["a", 0], ["b", 1080]] as const) {
    vi.spyOn(screen.getByTestId(`tab-${key}`), "getBoundingClientRect").mockImplementation(() => ({
      left: 200 + left - scrollLeft, right: 320 + left - scrollLeft, width: 120,
    } as DOMRect));
  }
  return { readWidth, scrollTo, setWidth: (value: number) => { width = value; }, get left() { return scrollLeft; } };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  ["workspace", WorkspaceStrip], ["editor group", EditorStrip],
] as const)("%s tab resize lifecycle", (_name, Component) => {
  it("merges a resize burst outside observer delivery and reveals the active tab after hidden restoration", () => {
    const h = resizeHarness();
    render(<Component activeKey="b" />);
    const g = geometry();
    act(h.flush);
    g.readWidth.mockClear();
    g.scrollTo.mockClear();
    g.setWidth(300);
    act(() => { h.deliver(); h.deliver(); h.deliver(); });
    expect(g.readWidth).not.toHaveBeenCalled();
    expect(g.scrollTo).not.toHaveBeenCalled();
    expect(screen.getByTestId("overflow")).toHaveTextContent("false");
    expect(h.frames.size).toBe(1);
    act(h.flush);
    expect(screen.getByTestId("overflow")).toHaveTextContent("true");
    expect(screen.getByTestId("at-end")).toHaveTextContent("true");
    expect(g.left).toBe(900);
  });

  it("uses the newest active tab and width without replacing its observer", () => {
    const h = resizeHarness();
    const view = render(<Component activeKey="a" />);
    const g = geometry();
    act(h.flush);
    g.setWidth(100);
    act(h.deliver);
    view.rerender(<Component activeKey="b" />);
    g.setWidth(400);
    act(h.deliver);
    expect(h.observers).toHaveLength(1);
    expect(h.frames.size).toBe(1);
    act(h.flush);
    expect(g.left).toBe(800);
    expect(screen.getByTestId("at-end")).toHaveTextContent("true");
  });

  it("cancels pending measurement and ignores late notifications after unmount", () => {
    const h = resizeHarness();
    const view = render(<Component activeKey="b" />);
    const g = geometry();
    act(h.flush);
    g.readWidth.mockClear();
    act(h.deliver);
    expect(h.frames.size).toBe(1);
    view.unmount();
    expect(h.frames.size).toBe(0);
    expect(h.observers.every((observer) => !observer.connected)).toBe(true);
    act(() => { h.observers.forEach((observer) => observer.deliver()); h.flush(); });
    expect(g.readWidth).not.toHaveBeenCalled();
  });
});
