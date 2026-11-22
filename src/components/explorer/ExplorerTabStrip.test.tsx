import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useExplorerUiStore } from "../../stores/explorerUiStore";
import { ExplorerTabStrip } from "./ExplorerTabStrip";

const observers: Array<{ callback: ResizeObserverCallback }> = [];
const frames: FrameRequestCallback[] = [];

function installLayoutMocks() {
  observers.length = 0;
  frames.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    private readonly entry: { callback: ResizeObserverCallback };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback };
      observers.push(this.entry);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

function flushFrames() {
  act(() => {
    let guard = 0;
    while (frames.length && guard++ < 20) frames.shift()!(0);
  });
}

function setScrollMetrics(element: HTMLElement, clientWidth: number, scrollWidth: number) {
  let left = 0;
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => clientWidth });
  Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(element, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (value: number) => { left = value; },
  });
}

function measure() {
  act(() => observers.at(-1)?.callback([], {} as ResizeObserver));
  flushFrames();
}

const folder = (index: number): Tab => ({
  id: `folder-${index}`,
  type: "file-browser",
  title: `Folder ${index}`,
  closable: true,
  fileBrowser: { initialPath: `/fixture/${index}`, explorer: true },
});
const viewer = (id: string, title: string): Tab => ({
  id,
  type: "file-viewer",
  title,
  closable: true,
  fileViewer: { path: `/fixture/${title}`, kind: "text", mode: "source", source: "local" },
});

beforeEach(() => {
  localStorage.clear();
  installLayoutMocks();
  useAppStore.setState({ activeSideTab: "explorer", statusMessage: "" });
  useExplorerUiStore.getState().clearTabFilter();
  useExplorerStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useExplorerStore.setState({ tabs: [], activeTabId: null });
  useExplorerUiStore.getState().clearTabFilter();
});

describe("ExplorerTabStrip", () => {
  it("renders open tabs, keeps the scrollbar hidden and activates a tab", () => {
    useExplorerStore.setState({ tabs: [folder(1), viewer("v1", "README.md")], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    const tabs = screen.getAllByTestId("explorer-workspace-tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("data-tab-title", "Folder 1");
    expect(tabs[0]).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("explorer-tab-scroll-area")).toHaveClass("taomni-explorer-tab-scroll");
    fireEvent.click(tabs[1]);
    expect(useExplorerStore.getState().activeTabId).toBe("v1");
    expect(useAppStore.getState().activeSideTab).toBe("explorer");
  });

  it("shows paging arrows only while the strip overflows and disables them at the edges", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2), folder(3)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    expect(screen.queryByTestId("explorer-tab-scroll-left")).toBeNull();
    const area = screen.getByTestId("explorer-tab-scroll-area");
    setScrollMetrics(area, 300, 900);
    measure();
    const left = screen.getByTestId("explorer-tab-scroll-left");
    const right = screen.getByTestId("explorer-tab-scroll-right");
    expect(left).toBeDisabled();
    expect(right).toBeEnabled();
    fireEvent.click(right);
    expect(area.scrollLeft).toBeGreaterThan(0);
    const afterRight = area.scrollLeft;
    fireEvent.click(left);
    expect(area.scrollLeft).toBeLessThan(afterRight);
    expect(left).toBeDisabled();
    setScrollMetrics(area, 900, 900);
    measure();
    expect(screen.queryByTestId("explorer-tab-scroll-right")).toBeNull();
  });

  it("reveals an activated tab that sits outside the viewport", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2), folder(3)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    const area = screen.getByTestId("explorer-tab-scroll-area");
    setScrollMetrics(area, 300, 900);
    fireEvent.scroll(area);
    flushFrames();
    const tabs = screen.getAllByTestId("explorer-workspace-tab");
    tabs.forEach((tab, index) => {
      Object.defineProperty(tab, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: index * 200, right: index * 200 + 150, top: 0, bottom: 28, width: 150, height: 28, x: index * 200, y: 0, toJSON() {} }),
      });
    });
    act(() => { useExplorerStore.getState().setActiveTab("folder-3"); });
    flushFrames();
    expect(area.scrollLeft).toBe(258);
  });

  it("hides filtered tabs without closing them and exposes a clearable chip", () => {
    useExplorerStore.setState({ tabs: [folder(1), viewer("v1", "README.md")], activeTabId: "folder-1" });
    useExplorerUiStore.getState().setTabFilter({ category: "files", query: "" });
    render(<ExplorerTabStrip />);
    const visible = screen.getAllByTestId("explorer-workspace-tab");
    expect(visible).toHaveLength(1);
    expect(visible[0]).toHaveAttribute("data-tab-id", "v1");
    expect(screen.getByTestId("explorer-tab-filter-chip")).toHaveTextContent("Files");
    expect(useExplorerStore.getState().tabs).toHaveLength(2);
    fireEvent.click(screen.getByTestId("explorer-tab-filter-chip"));
    expect(useExplorerUiStore.getState().tabFilter).toEqual({ category: "all", query: "" });
    expect(screen.getAllByTestId("explorer-workspace-tab")).toHaveLength(2);
  });

  it("shows a no-match notice while a filter hides every tab", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2)], activeTabId: "folder-1" });
    useExplorerUiStore.getState().setTabFilter({ category: "all", query: "missing" });
    render(<ExplorerTabStrip />);
    expect(screen.queryAllByTestId("explorer-workspace-tab")).toHaveLength(0);
    expect(screen.getByTestId("explorer-tab-filter-empty")).toHaveTextContent("No matching tabs");
  });

  it("clears a stale filter when the active tab changes to a hidden tab", () => {
    useExplorerStore.setState({ tabs: [folder(1), viewer("v1", "README.md")], activeTabId: "v1" });
    useExplorerUiStore.getState().setTabFilter({ category: "files", query: "" });
    render(<ExplorerTabStrip />);
    expect(useExplorerUiStore.getState().tabFilter.category).toBe("files");
    act(() => { useExplorerStore.getState().setActiveTab("folder-1"); });
    expect(useExplorerUiStore.getState().tabFilter).toEqual({ category: "all", query: "" });
    expect(screen.getAllByTestId("explorer-workspace-tab")).toHaveLength(2);
  });

  it("keeps keyboard navigation on the visible tabs and supports middle-click close", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2), folder(3)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    const tabs = screen.getAllByTestId("explorer-workspace-tab");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(useExplorerStore.getState().activeTabId).toBe("folder-2");
    fireEvent.keyDown(screen.getAllByTestId("explorer-workspace-tab")[1], { key: "End" });
    expect(useExplorerStore.getState().activeTabId).toBe("folder-3");
    fireEvent.keyDown(screen.getAllByTestId("explorer-workspace-tab")[2], { key: "Home" });
    expect(useExplorerStore.getState().activeTabId).toBe("folder-1");
    fireEvent(tabs[2], new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(useExplorerStore.getState().tabs.map((tab) => tab.id)).toEqual(["folder-1", "folder-2"]);
  });

  it("pins and closes tabs from the context menu", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    fireEvent.contextMenu(screen.getAllByTestId("explorer-workspace-tab")[0], { clientX: 8, clientY: 8 });
    fireEvent.click(screen.getByTestId("explorer-tab-context-pin"));
    expect(useExplorerStore.getState().tabs.find((tab) => tab.id === "folder-1")?.pinned).toBe(true);
    expect(screen.getByTestId("explorer-tab-pin-badge")).toBeInTheDocument();
    fireEvent.contextMenu(screen.getAllByTestId("explorer-workspace-tab")[1], { clientX: 8, clientY: 8 });
    fireEvent.click(screen.getByTestId("explorer-tab-context-close"));
    expect(useExplorerStore.getState().tabs.map((tab) => tab.id)).toEqual(["folder-1"]);
  });
});
