import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Breadcrumbs } from "./Breadcrumbs";

const pathSegments = [
  { label: "project", path: "", kind: "root" as const },
  { label: "source", path: "source", kind: "directory" as const },
  { label: "nested", path: "source/nested", kind: "directory" as const },
  { label: "README.md", path: "source/nested/README.md", kind: "file" as const },
];

function harness() {
  const deliveries: Array<() => void> = [];
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { deliveries.push(callback); }
    observe() {}
    disconnect = disconnect;
  });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const request = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const view = render(<Breadcrumbs pathSegments={pathSegments} symbols={[]} position={{ line: 0, character: 0 }} />);
  const nav = screen.getByTestId("code-workspace-breadcrumbs");
  const full = nav.querySelector<HTMLElement>("[aria-hidden='true']")!;
  let width = 400;
  const available = vi.fn(() => width);
  Object.defineProperty(nav, "clientWidth", { configurable: true, get: available });
  const measure = vi.spyOn(full, "getBoundingClientRect").mockReturnValue({ width: 280 } as DOMRect);
  const resize = () => deliveries.at(-1)!();
  const flush = () => {
    const scheduled = [...frames.values()];
    frames.clear();
    scheduled.forEach((callback) => callback(0));
  };
  return { ...view, deliveries, frames, request, disconnect, available, measure, resize, flush, setWidth: (next: number) => { width = next; } };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("breadcrumb resize delivery", () => {
  it("defers layout reads and DOM changes until the next frame, merging resize bursts", () => {
    const h = harness();
    h.setWidth(100);
    act(() => { h.resize(); h.resize(); h.resize(); });
    expect(h.available).not.toHaveBeenCalled();
    expect(h.measure).not.toHaveBeenCalled();
    expect(screen.queryByTestId("code-workspace-breadcrumb-collapsed")).toBeNull();
    expect(h.frames.size).toBe(1);
    act(h.flush);
    expect(h.measure).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("code-workspace-breadcrumb-collapsed")).toBeInTheDocument();

    // The scheduled read uses the latest width. A transient narrow size must
    // not leave a collapsed path after the editor/status bar has grown again.
    act(() => { h.resize(); h.setWidth(400); h.resize(); });
    act(h.flush);
    expect(screen.queryByTestId("code-workspace-breadcrumb-collapsed")).toBeNull();
    expect(h.measure).toHaveBeenCalledTimes(2);
  });

  it("cancels queued measurements and ignores late deliveries after unmount", () => {
    const h = harness();
    act(h.resize);
    expect(h.frames.size).toBe(1);
    h.unmount();
    expect(h.disconnect).toHaveBeenCalled();
    expect(h.frames.size).toBe(0);
    act(() => { h.resize(); h.flush(); });
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(0);
  });

  it("keeps one observer and defers content measurements across edit/save updates", () => {
    const h = harness();
    for (let character = 1; character <= 8; character++) {
      h.rerender(<Breadcrumbs pathSegments={[...pathSegments]} symbols={[]} position={{ line: 0, character }} />);
    }
    expect(h.deliveries).toHaveLength(1);
    expect(h.disconnect).not.toHaveBeenCalled();
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(1);
    act(h.flush);
    expect(h.measure).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("code-workspace-breadcrumb-path-file")).toHaveTextContent("README.md");
  });

  it("measures the newest trail next frame when content changes during resize delivery", () => {
    const h = harness();
    h.setWidth(100);
    act(() => {
      h.resize();
      h.rerender(<Breadcrumbs pathSegments={pathSegments.map((segment) => segment.kind === "file"
        ? { ...segment, label: "changed.md", path: "source/nested/changed.md" }
        : segment)} symbols={[]} position={{ line: 1, character: 0 }} />);
    });
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(1);
    expect(h.deliveries).toHaveLength(1);
    act(h.flush);
    expect(h.measure).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("code-workspace-breadcrumb-path-file")).toHaveTextContent("changed.md");
    expect(screen.getByTestId("code-workspace-breadcrumb-collapsed")).toBeInTheDocument();
  });
});
