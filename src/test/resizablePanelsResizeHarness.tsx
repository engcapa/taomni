import { act, render } from "@testing-library/react";
import { createRef, useRef, type RefObject } from "react";
import * as Panels from "react-resizable-panels";
import type { GroupImperativeHandle, OnPanelResize, PanelImperativeHandle } from "react-resizable-panels";
import { vi } from "vitest";
import { useToolWindowPanelVisibility } from "../components/editor/workspace/hooks/useToolWindowPanelVisibility";

function PanelVisibility({ panelRef, open }: { panelRef: RefObject<PanelImperativeHandle | null>; open: boolean }) {
  const size = useRef(20);
  useToolWindowPanelVisibility(panelRef, open, size, "%");
  return null;
}

// jsdom supplies no geometry or ResizeObserver delivery loop. Only those browser
// boundaries are controlled here; Group/Panel registration and layout are real.
export class PanelResizeObserver {
  static instances: PanelResizeObserver[] = [];
  static delivering = false;
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    PanelResizeObserver.instances.push(this);
  }

  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.disconnected = true; this.targets.clear(); }

  entries(targets = [...this.targets]): ResizeObserverEntry[] {
    return targets.map((target) => ({
      target,
      borderBoxSize: [{ inlineSize: (target as HTMLElement).offsetWidth, blockSize: 600 }],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
      contentRect: target.getBoundingClientRect(),
    })) as ResizeObserverEntry[];
  }

  deliver(entries = this.entries()) {
    PanelResizeObserver.delivering = true;
    try { this.callback(entries, this as unknown as ResizeObserver); }
    finally { PanelResizeObserver.delivering = false; }
  }
}

export function installPanelResizeHarness() {
  PanelResizeObserver.instances = [];
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("ResizeObserver", PanelResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));

  return {
    frames,
    flushFrame() {
      const pending = [...frames];
      frames.clear();
      act(() => { pending.forEach(([, callback]) => callback(performance.now())); });
    },
  };
}

export function mountPanelResizeFixture(nested = false, components = Panels, syncVisibility = false, percentDefaults = false) {
  const { Group, Panel, Separator } = components;
  const groupRef = createRef<GroupImperativeHandle>();
  const nestedRef = createRef<GroupImperativeHandle>();
  const docsRef = createRef<PanelImperativeHandle>();
  const onLayoutChange = vi.fn(() => {
    if (PanelResizeObserver.delivering) throw new Error("Layout published during observer delivery");
  });
  const onLayoutChanged = vi.fn();
  const onResize = vi.fn<NonNullable<OnPanelResize>>(() => {
    if (PanelResizeObserver.delivering) throw new Error("Panel onResize ran during observer delivery");
  });
  const Fixture = ({ open = true }: { open?: boolean }) => <>
    <Group id="resize-root" groupRef={groupRef} defaultLayout={percentDefaults ? undefined : { editor: 80, docs: 20 }}
      onLayoutChange={onLayoutChange} onLayoutChanged={onLayoutChanged}>
      <Panel id="editor" defaultSize={percentDefaults ? "80%" : undefined} minSize={200} onResize={onResize}>
        {nested && <Group id="resize-nested" groupRef={nestedRef}>
          <Panel id="left" minSize={100} onResize={onResize}>left editor</Panel>
          <Separator />
          <Panel id="right" minSize={100} onResize={onResize}>right editor</Panel>
        </Group>}
      </Panel>
      <Separator />
      <Panel id="docs" panelRef={docsRef} defaultSize={percentDefaults ? "0%" : 235} minSize={185} collapsible
        groupResizeBehavior="preserve-pixel-size" onResize={onResize}>Documentation</Panel>
    </Group>
    {syncVisibility && <PanelVisibility panelRef={docsRef} open={open} />}
  </>;
  const view = render(<Fixture />);
  let width = 0;
  const reads = vi.fn();
  const element = (id: string) => view.container.querySelector<HTMLElement>(`[id="${id}"]`)!;
  const root = element("resize-root");
  const editor = element("editor");
  const panelWidth = (panel: HTMLElement, groupWidth: number) => {
    const siblings = [...panel.parentElement!.children].filter((child) => child.hasAttribute("data-panel"));
    const weight = (child: Element) => Number.parseFloat((child as HTMLElement).style.flexGrow || "1");
    return groupWidth * weight(panel) / siblings.reduce((sum, child) => sum + weight(child), 0);
  };
  for (const node of view.container.querySelectorAll<HTMLElement>("[data-group], [data-panel]")) {
    const getWidth = () => {
      reads();
      const groupWidth = node === root || node.parentElement === root ? width : panelWidth(editor, width);
      return node.hasAttribute("data-group") ? groupWidth : panelWidth(node, groupWidth);
    };
    Object.defineProperty(node, "offsetWidth", { configurable: true, get: getWidth });
    Object.defineProperty(node, "offsetHeight", { configurable: true, get: () => width ? 600 : 0 });
    node.getBoundingClientRect = () => new DOMRect(0, 0, getWidth(), width ? 600 : 0);
  }
  const observer = (id: string) => {
    const result = PanelResizeObserver.instances.find((candidate) => candidate.targets.has(element(id)));
    if (!result) throw new Error(`No live observer for ${id}`);
    return result;
  };
  const deliver = (id = "resize-root") => {
    const owner = observer(id);
    const entries = owner.entries();
    reads.mockClear();
    act(() => owner.deliver(entries));
  };
  return { ...view, groupRef, nestedRef, docsRef, onLayoutChange, onLayoutChanged, onResize, reads, observer,
    setWidth(value: number) { width = value; }, deliver,
    setOpen(open: boolean) { view.rerender(<Fixture open={open} />); } };
}
