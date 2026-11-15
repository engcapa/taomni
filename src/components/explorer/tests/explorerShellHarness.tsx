import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, afterEach, vi } from "vitest";
import type { FileEntry } from "../../../lib/sftp";
import { useSftpStore } from "../../../stores/sftpStore";
import { inFlightAttaches, sessionRefCounts } from "../../../stores/sftp/lifetime";
import { inFlightLocalAttaches } from "../../../stores/sftp/localLifetime";
import { setLocale } from "../../../lib/i18n";
import { setExplorerClipboard } from "../explorerClipboard";
import { setExplorerPreferences } from "../explorerPreferences";
import { ExplorerShell, type ExplorerShellProps } from "../ExplorerShell";

const native = vi.hoisted(() => ({
  platform: "linux" as "linux" | "macos" | "windows",
  explorerWriteClipboardFiles: vi.fn(),
  explorerUpdateCutClipboard: vi.fn(),
  explorerSameVolume: vi.fn(),
  localCopyEntries: vi.fn(),
  localMoveEntries: vi.fn(),
  localTrashEntries: vi.fn(),
  localTrashRestore: vi.fn(),
  localRenameEntry: vi.fn(),
  localCreateEntry: vi.fn(),
  localProperties: vi.fn(),
  explorerCancelOperation: vi.fn(),
  readFilesResult: vi.fn(),
  writeText: vi.fn(),
  openExplorer: vi.fn(),
  openFile: vi.fn(async () => "viewer"),
  sftpOpenPath: vi.fn(),
  sftpRemove: vi.fn(),
}));
vi.mock("../../../lib/explorer", () => ({
  explorerWriteClipboardFiles: native.explorerWriteClipboardFiles,
  explorerUpdateCutClipboard: native.explorerUpdateCutClipboard,
  explorerSameVolume: native.explorerSameVolume,
  localCopyEntries: native.localCopyEntries,
  localMoveEntries: native.localMoveEntries,
  localTrashEntries: native.localTrashEntries,
  localTrashRestore: native.localTrashRestore,
  localRenameEntry: native.localRenameEntry,
  localCreateEntry: native.localCreateEntry,
  localProperties: native.localProperties,
  explorerCancelOperation: native.explorerCancelOperation,
}));
vi.mock("../../../lib/clipboard", () => ({ readFilesResult: native.readFilesResult, writeText: native.writeText }));
vi.mock("../../../lib/runtime", () => ({ getAppPlatform: () => native.platform, isTauriRuntime: () => false }));
vi.mock("../../../lib/explorer/openExplorer", () => ({ openExplorer: native.openExplorer }));
vi.mock("../../../lib/openFile", async (original) => ({ ...await original<typeof import("../../../lib/openFile")>(), openFile: native.openFile }));
vi.mock("../../../lib/sftpController", () => ({ useSftpController: () => ({}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../ExplorerNavTree", () => ({ ExplorerNavTree: () => <nav data-testid="explorer-nav-tree" /> }));
vi.mock("../preview/ExplorerPreviewPane", () => ({
  ExplorerPreviewPane: ({ entries, onClose }: { entries: FileEntry[]; onClose: () => void }) => <aside data-testid="explorer-preview"><span>{entries.map((entry) => entry.name).join(",")}</span><button onClick={onClose} data-testid="preview-test-close">Close</button></aside>,
}));
vi.mock("../../../lib/sftp", async (original) => ({
  ...await original<typeof import("../../../lib/sftp")>(),
  sftpLocalHome: vi.fn(async () => "/home/test"),
  sftpListLocalDetailed: vi.fn(async (path: string) => {
    const entries = filesystem.get(path);
    if (!entries) throw new Error(`No such file: ${path}`);
    return { entries: entries.map((entry) => ({ ...entry })), skippedCount: 0, diagnostics: [] };
  }),
  sftpOpenPath: native.sftpOpenPath,
  sftpRemove: native.sftpRemove,
}));

export { native };
export const filesystem = new Map<string, FileEntry[]>();
export const TAB = "explorer-shell-test";
let shellWidth = 1200;
const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];

export function file(name: string, extra: Partial<FileEntry> = {}, parent = "/fixture"): FileEntry {
  return { name, path: `${parent}/${name}`, size: 10, mtime: 1, mode: 0o644, fileType: "file", isHidden: name.startsWith("."), ...extra };
}
export function defaultEntries() {
  return [file("folder", { fileType: "dir", size: 0 }), file("alpha.txt", { size: 20 }), file("beta.md", { size: 30 }), file("gamma.csv", { size: 40 }), file(".hidden.txt", { size: 50 })];
}
export function selection(tabId = TAB) { return useSftpStore.getState().sessions[tabId]?.local.selection ?? []; }
export function row(name: string, root: HTMLElement = screen.getByTestId("explorer-tab")) {
  const result = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="explorer-file-row"]')).find((entry) => entry.dataset.name === name);
  if (!result) throw new Error(`Missing row ${name}`);
  return result;
}
export function rows(root: HTMLElement = screen.getByTestId("explorer-tab")) {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-testid="explorer-file-row"]')).map((entry) => entry.dataset.name);
}
export function pointer(target: Window | Document | Node | Element, type: string, init: PointerEventInit) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperties(event, { pointerId: { value: init.pointerId ?? 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
  fireEvent(target, event);
}
export function setWidth(width: number) {
  act(() => {
    shellWidth = width;
    for (const observer of observers) {
      observer.callback(Array.from(observer.targets, (target) => ({ target, borderBoxSize: [{ blockSize: 400, inlineSize: width }] } as unknown as ResizeObserverEntry)), {} as ResizeObserver);
    }
  });
}
export async function mountShell(overrides: Partial<ExplorerShellProps> = {}) {
  const props: ExplorerShellProps = { tabId: TAB, initialPath: "/fixture", onOpenTerminal: vi.fn(), ...overrides };
  const view = render(<ExplorerShell {...props} />);
  await waitFor(() => {
    if (!view.container.querySelector('[data-testid="explorer-file-row"]')) throw new Error(`Waiting for initial directory: ${JSON.stringify(useSftpStore.getState().sessions[props.tabId]?.local)} | ${view.container.querySelector('[data-testid="explorer-file-list"]')?.innerHTML}`);
  });
  return { ...view, props, root: within(view.container).getByTestId("explorer-tab"), list: within(view.container).getByTestId("explorer-file-list") };
}
export function installShellHarness() {
  beforeEach(() => {
    vi.clearAllMocks();
    native.platform = "linux";
    shellWidth = 1200;
    observers.length = 0;
    filesystem.clear(); filesystem.set("/fixture", defaultEntries()); filesystem.set("/fixture/folder", [file("child.txt", {}, "/fixture/folder")]);
    useSftpStore.setState({ sessions: {} });
    sessionRefCounts.clear(); inFlightLocalAttaches.clear(); inFlightAttaches.clear();
    setLocale("en");
    setExplorerPreferences({ view: "details", sortKey: "name", sortDir: "asc", showHidden: false, preview: true, previewPosition: "right", previewWidth: 300, navWidth: 210, wrap: false, pinnedPaths: [], expandedPaths: [] });
    setExplorerClipboard(null);
    vi.stubGlobal("ResizeObserver", class {
      record: typeof observers[number];
      constructor(callback: ResizeObserverCallback) { this.record = { callback, targets: new Set() }; observers.push(this.record); }
      observe(target: Element) { this.record.targets.add(target); }
      unobserve(target: Element) { this.record.targets.delete(target); }
      disconnect() { this.record.targets.clear(); }
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.testid === "explorer-tab" ? shellWidth : 600; });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.testid === "explorer-file-list" ? 280 : 28; });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) { return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 280, width: 600, height: 280, toJSON: () => ({}) }; });
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(28000);
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; this.dispatchEvent(new Event("scroll")); } });
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    native.explorerWriteClipboardFiles.mockResolvedValue(undefined);
    native.explorerUpdateCutClipboard.mockResolvedValue(true);
    native.explorerSameVolume.mockResolvedValue(true);
    native.readFilesResult.mockResolvedValue({ ok: true, paths: [] });
    native.localCopyEntries.mockResolvedValue({ done: [], failed: [] });
    native.localMoveEntries.mockResolvedValue({ done: [], failed: [] });
    native.localTrashEntries.mockResolvedValue({ trashed: [], failed: [] });
    native.localTrashRestore.mockResolvedValue({ done: [], failed: [] });
    native.localRenameEntry.mockImplementation(async (path: string, name: string) => {
      const parent = path.slice(0, path.lastIndexOf("/"));
      const entries = filesystem.get(parent)!;
      if (entries.some((entry) => entry.name === name && entry.path !== path)) throw new Error("already_exists: same name");
      const entry = entries.find((entry) => entry.path === path)!;
      entry.name = name; entry.path = `${parent}/${name}`;
      return entry.path;
    });
    native.localCreateEntry.mockImplementation(async (parent: string, name: string, directory: boolean) => {
      const entry = file(name, { fileType: directory ? "dir" : "file", size: 0 }, parent);
      filesystem.get(parent)!.push(entry);
      if (directory) filesystem.set(entry.path, []);
      return entry.path;
    });
    native.localProperties.mockImplementation(async (path: string) => ({ path, name: path.split("/").at(-1), fileType: "file", size: 10, itemCount: 1, truncated: false, mtime: 1, createdAt: null, mode: 0o644, owner: null, group: null, symlinkTarget: null }));
    native.explorerCancelOperation.mockResolvedValue(undefined);
    native.writeText.mockResolvedValue(undefined);
    native.openExplorer.mockResolvedValue("opened-explorer");
    native.sftpOpenPath.mockResolvedValue(undefined);
    native.sftpRemove.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    useSftpStore.setState({ sessions: {} });
    sessionRefCounts.clear(); inFlightLocalAttaches.clear(); inFlightAttaches.clear();
    setExplorerClipboard(null);
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
}
