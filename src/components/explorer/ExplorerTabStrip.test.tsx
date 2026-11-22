import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useExplorerUiStore } from "../../stores/explorerUiStore";
import { useSftpStore } from "../../stores/sftpStore";
import { freshSession } from "../../stores/sftp/listing";
import { ExplorerTabStrip } from "./ExplorerTabStrip";

const explorerMocks = vi.hoisted(() => ({
  open: vi.fn(async (_path?: string, _options?: { forceNew?: boolean }) => "explorer-new"),
}));
const clipboardMocks = vi.hoisted(() => ({ writeText: vi.fn(async () => undefined) }));

vi.mock("../../lib/explorer/openExplorer", () => ({ openExplorer: explorerMocks.open }));
vi.mock("../../lib/clipboard", () => ({ writeText: clipboardMocks.writeText }));

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

const tabs = () => screen.getAllByTestId("explorer-workspace-tab");
const openContextMenu = (element: HTMLElement = tabs()[0]) =>
  fireEvent.contextMenu(element, { clientX: 8, clientY: 8 });
const menuItemIds = () => Array.from(
  screen.getByTestId("context-menu").querySelectorAll<HTMLElement>("button"),
).map((button) => button.dataset.testid);

beforeEach(() => {
  localStorage.clear();
  installLayoutMocks();
  exploreMocksReset();
  useAppStore.setState({ activeSideTab: "explorer", statusMessage: "" });
  useExplorerUiStore.getState().clearTabFilter();
  useExplorerStore.setState({ tabs: [], activeTabId: null });
  useSftpStore.setState({ sessions: {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useExplorerStore.setState({ tabs: [], activeTabId: null });
  useExplorerUiStore.getState().clearTabFilter();
});

function exploreMocksReset() {
  explorerMocks.open.mockClear();
  clipboardMocks.writeText.mockClear();
}

describe("ExplorerTabStrip", () => {
  it("renders open tabs, keeps the scrollbar hidden and activates a tab", () => {
    useExplorerStore.setState({ tabs: [folder(1), viewer("v1", "README.md")], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    const items = tabs();
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("data-tab-title", "Folder 1");
    expect(items[0]).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("explorer-tab-scroll-area")).toHaveClass("taomni-explorer-tab-scroll");
    fireEvent.click(items[1]);
    expect(useExplorerStore.getState().activeTabId).toBe("v1");
    expect(useAppStore.getState().activeSideTab).toBe("explorer");
  });

  it("uses the Sessions tab style and the shared type icons (U4)", () => {
    useExplorerStore.setState({ tabs: [folder(1), viewer("v1", "README.md"), folder(2)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    for (const tab of tabs()) {
      expect(tab).toHaveClass("taomni-tab");
      expect(tab).not.toHaveClass("taomni-workspace-tab");
      expect(tab).toHaveAttribute("data-tab-style", "session");
    }
    // file-browser keeps the prototype folder icon; file-viewer uses the shared
    // file icon from TabIcon instead of the old generic FileText glyph.
    expect(tabs()[0].querySelector("svg.taomni-explorer-tab-icon")).toBeTruthy();
    expect(tabs()[1].querySelector("svg.w-4.h-4")).toBeTruthy();
    expect(tabs()[1].querySelector("svg.taomni-explorer-tab-icon")).toBeNull();
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
    tabs().forEach((tab, index) => {
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
    const visible = tabs();
    expect(visible).toHaveLength(1);
    expect(visible[0]).toHaveAttribute("data-tab-id", "v1");
    expect(screen.getByTestId("explorer-tab-filter-chip")).toHaveTextContent("Files");
    expect(useExplorerStore.getState().tabs).toHaveLength(2);
    fireEvent.click(screen.getByTestId("explorer-tab-filter-chip"));
    expect(useExplorerUiStore.getState().tabFilter).toEqual({ category: "all", query: "" });
    expect(tabs()).toHaveLength(2);
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
    expect(tabs()).toHaveLength(2);
  });

  it("keeps keyboard navigation on the visible tabs and supports middle-click close", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2), folder(3)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    const items = tabs();
    fireEvent.keyDown(items[0], { key: "ArrowRight" });
    expect(useExplorerStore.getState().activeTabId).toBe("folder-2");
    fireEvent.keyDown(tabs()[1], { key: "End" });
    expect(useExplorerStore.getState().activeTabId).toBe("folder-3");
    fireEvent.keyDown(tabs()[2], { key: "Home" });
    expect(useExplorerStore.getState().activeTabId).toBe("folder-1");
    fireEvent(items[2], new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(useExplorerStore.getState().tabs.map((tab) => tab.id)).toEqual(["folder-1", "folder-2"]);
  });

  it("closes a tab from the Sessions-style close X", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    const close = within(tabs()[1]).getByTestId("tab-close");
    expect(close).toHaveClass("w-3", "h-3", "ml-1", "opacity-60");
    fireEvent.click(close);
    expect(useExplorerStore.getState().tabs.map((tab) => tab.id)).toEqual(["folder-1"]);
    expect(useExplorerStore.getState().activeTabId).toBe("folder-1");
  });

  it("pins and closes tabs from the context menu", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    openContextMenu(tabs()[0]);
    fireEvent.click(screen.getByTestId("explorer-tab-context-pin"));
    expect(useExplorerStore.getState().tabs.find((tab) => tab.id === "folder-1")?.pinned).toBe(true);
    expect(screen.getByTestId("explorer-tab-pin-badge")).toBeInTheDocument();
    openContextMenu(tabs()[1]);
    fireEvent.click(screen.getByTestId("explorer-tab-context-close"));
    expect(useExplorerStore.getState().tabs.map((tab) => tab.id)).toEqual(["folder-1"]);
  });

  it("offers the full Sessions-parity context menu in the required order with 12px icons", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    openContextMenu(tabs()[0]);
    // Shared surface test id: the QA runner only resolves `context-menu`.
    const menu = screen.getByTestId("context-menu");
    expect(menuItemIds()).toEqual([
      "explorer-tab-context-close",
      "explorer-tab-context-close-others",
      "explorer-tab-context-close-all",
      "explorer-tab-context-rename",
      "explorer-tab-context-duplicate",
      "explorer-tab-context-copy-path",
      "explorer-tab-context-move-first",
      "explorer-tab-context-move-left",
      "explorer-tab-context-move-right",
      "explorer-tab-context-move-last",
      "explorer-tab-context-pin",
      "explorer-tab-context-close-left",
      "explorer-tab-context-close-right",
      "explorer-tab-context-close-unmodified",
      "explorer-tab-context-close-unpinned",
    ]);
    const icons = Array.from(menu.querySelectorAll("button svg"));
    expect(icons).toHaveLength(15);
    for (const icon of icons) expect(icon).toHaveClass("w-3", "h-3");
  });

  it("disables move-first/left on the first tab and move-right/last on the last tab", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2), folder(3)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    openContextMenu(tabs()[0]);
    expect(screen.getByTestId("explorer-tab-context-move-first")).toBeDisabled();
    expect(screen.getByTestId("explorer-tab-context-move-left")).toBeDisabled();
    expect(screen.getByTestId("explorer-tab-context-move-right")).toBeEnabled();
    fireEvent.keyDown(document, { key: "Escape" });
    openContextMenu(tabs()[2]);
    expect(screen.getByTestId("explorer-tab-context-move-right")).toBeDisabled();
    expect(screen.getByTestId("explorer-tab-context-move-last")).toBeDisabled();
  });

  it("moves a tab to first and last from the context menu", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2), folder(3)], activeTabId: "folder-2" });
    render(<ExplorerTabStrip />);
    openContextMenu(tabs()[1]);
    fireEvent.click(screen.getByTestId("explorer-tab-context-move-first"));
    expect(useExplorerStore.getState().tabs.map((tab) => tab.id)).toEqual(["folder-2", "folder-1", "folder-3"]);
    openContextMenu(tabs()[0]);
    fireEvent.click(screen.getByTestId("explorer-tab-context-move-last"));
    expect(useExplorerStore.getState().tabs.map((tab) => tab.id)).toEqual(["folder-1", "folder-3", "folder-2"]);
  });

  it("duplicates only file-browser tabs into a new Explorer tab at the current directory", () => {
    useExplorerStore.setState({ tabs: [folder(1), viewer("v1", "README.md")], activeTabId: "folder-1" });
    const session = freshSession("folder-1");
    useSftpStore.setState({ sessions: { "folder-1": { ...session, local: { ...session.local, path: "/fixture/current" } } } });
    render(<ExplorerTabStrip />);
    fireEvent.contextMenu(tabs()[1], { clientX: 8, clientY: 8 });
    expect(screen.getByTestId("explorer-tab-context-duplicate")).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.contextMenu(tabs()[0], { clientX: 8, clientY: 8 });
    expect(screen.getByTestId("explorer-tab-context-duplicate")).toBeEnabled();
    fireEvent.click(screen.getByTestId("explorer-tab-context-duplicate"));
    expect(explorerMocks.open).toHaveBeenCalledWith("/fixture/current", { forceNew: true });
  });

  it("copies the visible path and reports it in the status bar", async () => {
    useExplorerStore.setState({ tabs: [folder(1), viewer("v1", "notes.txt")], activeTabId: "v1" });
    render(<ExplorerTabStrip />);
    fireEvent.contextMenu(tabs()[0], { clientX: 8, clientY: 8 });
    fireEvent.click(screen.getByTestId("explorer-tab-context-copy-path"));
    expect(clipboardMocks.writeText).toHaveBeenCalledWith("/fixture/1");
    // Viewer tabs copy their file path instead of the browser directory.
    fireEvent.contextMenu(tabs()[1], { clientX: 8, clientY: 8 });
    fireEvent.click(screen.getByTestId("explorer-tab-context-copy-path"));
    expect(clipboardMocks.writeText).toHaveBeenLastCalledWith("/fixture/notes.txt");
    await act(async () => {});
    expect(useAppStore.getState().statusMessage).toBe("Path copied");
  });

  it("starts an inline rename from a title double-click and commits with Enter", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2)], activeTabId: "folder-1" });
    render(<ExplorerTabStrip />);
    fireEvent.doubleClick(within(tabs()[0]).getByTestId("explorer-tab-title"));
    const input = screen.getByTestId("explorer-tab-rename-input");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "  Renamed  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useExplorerStore.getState().tabs[0].title).toBe("Renamed");
    expect(screen.queryByTestId("explorer-tab-rename-input")).toBeNull();
    expect(tabs()[0]).toHaveAttribute("data-tab-title", "Renamed");
    // Enter must not re-activate/navigate the tab or bubble to the strip.
    expect(useExplorerStore.getState().activeTabId).toBe("folder-1");
  });

  it("renames from the context menu and cancels with Escape or commits on blur", () => {
    useExplorerStore.setState({ tabs: [folder(1), folder(2)], activeTabId: "folder-2" });
    render(<ExplorerTabStrip />);
    openContextMenu(tabs()[0]);
    fireEvent.click(screen.getByTestId("explorer-tab-context-rename"));
    expect(useExplorerStore.getState().activeTabId).toBe("folder-1");
    const input = screen.getByTestId("explorer-tab-rename-input");
    fireEvent.change(input, { target: { value: "Cancelled" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("explorer-tab-rename-input")).toBeNull();
    expect(useExplorerStore.getState().tabs[0].title).toBe("Folder 1");

    fireEvent.doubleClick(within(tabs()[0]).getByTestId("explorer-tab-title"));
    fireEvent.change(screen.getByTestId("explorer-tab-rename-input"), { target: { value: "Blurred" } });
    fireEvent.blur(screen.getByTestId("explorer-tab-rename-input"));
    expect(useExplorerStore.getState().tabs[0].title).toBe("Blurred");
  });
});
