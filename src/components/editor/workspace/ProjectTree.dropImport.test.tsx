import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTree, type ProjectTreeProps } from "./ProjectTree";
import { NATIVE_FILE_DROP_EVENT } from "../../../lib/osFileDrop";
import { NATIVE_FILE_DRAG_EVENT } from "../../../lib/nativeFileDrag";

function props(): ProjectTreeProps & { onImportPaths: ReturnType<typeof vi.fn> } {
  const state = (path: string, fileType: "file" | "dir") => ({
    entries: [{ path, name: path.split("/").at(-1)!, fileType, size: 0, mtime: 1, isHidden: false }],
    loaded: true, loading: false, error: null,
  });
  return {
    roots: [{ id: "one", name: "one", path: "/one", kind: "folder" }, { id: "two", name: "two", path: "/two", kind: "folder" }],
    looseFiles: [{ id: "loose", name: "outside.txt", path: "/outside.txt" }],
    directories: { "one:": state("note.txt", "file"), "two:": state("dest", "dir"), "two:dest": state("dest/old.txt", "file") },
    compactChains: {}, flatFiles: {}, treeViewMode: "tree", treeFilter: "",
    expandedRoots: new Set(["one", "two"]), expandedDirs: new Set(["two:dest"]),
    selected: { kind: "file", ref: { kind: "root", rootId: "one", path: "note.txt" } }, activeKey: "root:one:note.txt",
    openFiles: {}, gitChangeByRootPath: new Map(), onSelect: vi.fn(), onOpenFile: vi.fn(),
    onToggleDir: vi.fn(), onToggleRoot: vi.fn(), onContextMenu: vi.fn(), onImportPaths: vi.fn(async () => {}),
  };
}
const transfer = (uri = "file:///external/%E8%AF%B4%E6%98%8E%20note.txt\nfile:///external/bundle") => ({
  types: ["Files", "text/uri-list"], files: [], dropEffect: "none", getData: (type: string) => type === "text/uri-list" ? uri : "",
});
const sendNative = (event: string, detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent(event, { detail })); });
let hit: Element | null = null;
beforeEach(() => {
  hit = null;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => hit) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("production Project tree OS import", () => {
  it.each(["tree", "list", "compact"] as const)("highlights only the hovered directory and imports into root2 in %s view", (mode) => {
    const input = props();
    render(<div role="tree"><ProjectTree {...input} treeViewMode={mode} /></div>);
    const directory = screen.getByTestId("code-workspace-tree-dir");
    const dataTransfer = transfer();
    fireEvent.dragEnter(directory.querySelector("span")!, { dataTransfer });
    expect(directory).toHaveAttribute("data-drop-target", "true");
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(directory, { dataTransfer });
    expect(input.onImportPaths).toHaveBeenCalledExactlyOnceWith({ rootId: "two", path: "dest" }, ["/external/说明 note.txt", "/external/bundle"]);
    expect(directory).not.toHaveAttribute("data-drop-target");
    expect(input.onSelect).not.toHaveBeenCalled();
    expect(input.onOpenFile).not.toHaveBeenCalled();
  });

  it("switches highlight between roots and directories, clearing on leave, cancel and unmount", () => {
    const input = props();
    const { unmount } = render(<ProjectTree {...input} />);
    const root = screen.getAllByTestId("code-workspace-tree-root")[1];
    const directory = screen.getByTestId("code-workspace-tree-dir");
    fireEvent.dragOver(root, { dataTransfer: transfer() });
    expect(root).toHaveAttribute("data-drop-target", "true");
    fireEvent.dragOver(directory, { dataTransfer: transfer() });
    expect(root).not.toHaveAttribute("data-drop-target");
    expect(directory).toHaveAttribute("data-drop-target", "true");
    fireEvent.dragLeave(directory, { relatedTarget: document.body });
    expect(directory).not.toHaveAttribute("data-drop-target");
    fireEvent.dragOver(directory, { dataTransfer: transfer() });
    fireEvent(window, new Event("dragend"));
    expect(directory).not.toHaveAttribute("data-drop-target");
    fireEvent.dragOver(directory, { dataTransfer: transfer() });
    unmount();
    expect(directory).not.toHaveAttribute("data-drop-target");
    sendNative(NATIVE_FILE_DROP_EVENT, { paths: ["/external/new"], clientX: 10, clientY: 10 });
    expect(input.onImportPaths).not.toHaveBeenCalled();
  });

  it("uses native pointer hit-testing, not the current selection, and removes highlight on native leave", () => {
    const input = props();
    render(<ProjectTree {...input} />);
    hit = screen.getByTestId("code-workspace-tree-dir").querySelector("span");
    sendNative(NATIVE_FILE_DRAG_EVENT, { type: "enter", clientX: 25, clientY: 50 });
    const directory = screen.getByTestId("code-workspace-tree-dir");
    expect(directory).toHaveAttribute("data-drop-target", "true");
    sendNative(NATIVE_FILE_DRAG_EVENT, { type: "leave" });
    expect(directory).not.toHaveAttribute("data-drop-target");
    hit = screen.getAllByTestId("code-workspace-tree-root")[1];
    sendNative(NATIVE_FILE_DROP_EVENT, { paths: ["C:\\external\\note.bin"], clientX: 25, clientY: 50 });
    expect(input.onImportPaths).toHaveBeenCalledExactlyOnceWith({ rootId: "two", path: "" }, ["C:\\external\\note.bin"]);
    expect(document.elementFromPoint).toHaveBeenCalledWith(25, 50);
  });

  it("does not accept files, loose files, blank space, overlay or app-internal drags", () => {
    const input = props();
    const { container } = render(<ProjectTree {...input} />);
    for (const element of [screen.getAllByTestId("code-workspace-tree-file")[0], screen.getByTestId("code-workspace-tree-loose-file"), container, document.body]) {
      hit = element;
      fireEvent.drop(element, { dataTransfer: transfer() });
      sendNative(NATIVE_FILE_DROP_EVENT, { paths: ["/external/new"], clientX: 20, clientY: 20 });
    }
    const directory = screen.getByTestId("code-workspace-tree-dir");
    fireEvent.dragOver(directory, { dataTransfer: { types: ["application/x-taomni-files"], dropEffect: "move" } });
    expect(directory).not.toHaveAttribute("data-drop-target");
    fireEvent.drop(directory, { dataTransfer: { types: ["application/x-taomni-files"] } });
    fireEvent.drop(directory, { dataTransfer: transfer("https://example.test/note.txt") });
    expect(input.onImportPaths).not.toHaveBeenCalled();
  });

  it("imports to the compact endpoint or a directory search result rather than its display ancestor", () => {
    const input = props();
    const compact = { "two:dest": { path: "dest/nested", entries: [], loading: false, error: null } };
    const { rerender } = render(<ProjectTree {...input} treeViewMode="compact" compactChains={compact} />);
    fireEvent.drop(screen.getByTestId("code-workspace-tree-dir"), { dataTransfer: transfer() });
    expect(input.onImportPaths).toHaveBeenLastCalledWith({ rootId: "two", path: "dest/nested" }, expect.any(Array));
    const search = { entries: [{ path: "docs/deep", name: "deep", fileType: "dir" as const, size: 0, mtime: 1, isHidden: false }], loaded: true, loading: false, truncated: false, error: null };
    rerender(<ProjectTree {...input} treeViewMode="files" treeFilter="deep" flatFiles={{ two: search }} />);
    fireEvent.drop(screen.getByTestId("code-workspace-tree-dir"), { dataTransfer: transfer() });
    expect(input.onImportPaths).toHaveBeenLastCalledWith({ rootId: "two", path: "docs/deep" }, expect.any(Array));
  });

  it("rebinds against current roots and callbacks without retaining duplicate listeners", () => {
    const input = props();
    const { rerender } = render(<ProjectTree {...input} />);
    const second = vi.fn(async () => {});
    rerender(<ProjectTree {...input} onImportPaths={second} />);
    hit = screen.getByTestId("code-workspace-tree-dir");
    sendNative(NATIVE_FILE_DROP_EVENT, { paths: ["/external/new"], clientX: 20, clientY: 20 });
    expect(input.onImportPaths).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    rerender(<ProjectTree {...input} roots={[input.roots[0]]} onImportPaths={second} />);
    hit = document.body;
    sendNative(NATIVE_FILE_DROP_EVENT, { paths: ["/external/new"], clientX: 20, clientY: 20 });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
