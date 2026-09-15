import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTree, type ProjectTreeProps } from "./ProjectTree";
import { navigateProjectTree } from "./projectTreeNavigation";
import { rootDirKey, type TreeSelection } from "./codeWorkspaceModel";

const open = vi.fn();
function TreeHarness({ mode }: { mode: ProjectTreeProps["treeViewMode"] }) {
  const [selected, onSelect] = useState<TreeSelection | null>(null);
  const onToggleRoot = vi.fn();
  const onToggleDir = vi.fn();
  const item = (path: string, fileType: "file" | "dir") => ({ name: path.split("/").at(-1)!, path, fileType, size: 12, mtime: 1, isHidden: false });
  const state = (path: string, fileType: "file" | "dir") => ({ entries: [item(path, fileType)], loading: false, loaded: true, error: null });
  const dir = mode === "compact" ? "src/main" : "src";
  return <div role="tree" aria-label="Test project" tabIndex={0} onKeyDown={(event) => {
    if (navigateProjectTree(event.currentTarget, event.key, { onSelect, onToggleRoot, onToggleDir })) event.preventDefault();
  }}>
    <ProjectTree
      roots={[{ id: "root", name: "fixture", path: "/fixture", kind: "folder" }]}
      looseFiles={[{ id: "loose", name: "outside.txt", path: "/outside.txt" }]}
      directories={{ [rootDirKey("root", "")]: state("src", "dir"), [rootDirKey("root", dir)]: state(`${dir}/example.ts`, "file") }}
      compactChains={mode === "compact" ? { [rootDirKey("root", "src")]: { path: "src/main", entries: [item("src", "dir"), item("src/main", "dir")], loading: false, error: null } } : {}}
      flatFiles={{ root: { ...state("src/example.ts", "file"), truncated: false } }}
      treeViewMode={mode} treeFilter="" expandedRoots={new Set(["root"])} expandedDirs={new Set([rootDirKey("root", dir)])}
      selected={selected} activeKey={null} openFiles={{}} gitChangeByRootPath={new Map()}
      onToggleRoot={onToggleRoot} onToggleDir={onToggleDir} onSelect={onSelect} onOpenFile={open} onContextMenu={() => {}}
    />
  </div>;
}

describe("ProjectTree navigation across views", () => {
  afterEach(cleanup);
  it.each(["tree", "compact", "flat"] as const)("keeps selection and visible ancestry in %s view, including loose files", (mode) => {
    open.mockClear();
    render(<TreeHarness mode={mode} />);
    const tree = screen.getByRole("tree");
    const press = (key: string) => fireEvent.keyDown(tree, { key });
    press("Home");
    expect(screen.getByTestId("code-workspace-tree-root")).toHaveAttribute("aria-selected", "true");
    press("ArrowRight");
    if (mode !== "flat") press("ArrowRight");
    const file = screen.getByTestId(mode === "flat" ? "code-workspace-flat-file" : "code-workspace-tree-file");
    expect(file).toHaveFocus();
    expect(file).toHaveAttribute("aria-selected", "true");
    press("ArrowLeft");
    expect(screen.getByTestId(mode === "flat" ? "code-workspace-tree-root" : "code-workspace-tree-dir")).toHaveAttribute("aria-selected", "true");
    press("End");
    const loose = screen.getByTestId("code-workspace-tree-loose-file");
    expect(loose).toHaveFocus();
    expect(loose).toHaveAttribute("aria-selected", "true");
    press("ArrowLeft");
    expect(loose).toHaveAttribute("aria-selected", "true");
    press("ArrowUp");
    expect(file).toHaveFocus();
    expect(open).not.toHaveBeenCalled();
  });

  it("DEC-TOF-01: single click only selects; double click opens with preview: false", () => {
    open.mockClear();
    const onToggleRoot = vi.fn();
    const onToggleDir = vi.fn();
    const onSelect = vi.fn();

    render(
      <ProjectTree
        roots={[{ id: "root", name: "fixture", path: "/fixture", kind: "folder" }]}
        looseFiles={[{ id: "loose", name: "outside.txt", path: "/outside.txt" }]}
        directories={{
          [rootDirKey("root", "")]: {
            entries: [{ name: "src", path: "src", fileType: "dir", size: 0, mtime: 1, isHidden: false }],
            loading: false,
            loaded: true,
            error: null,
          },
          [rootDirKey("root", "src")]: {
            entries: [{ name: "example.ts", path: "src/example.ts", fileType: "file", size: 10, mtime: 1, isHidden: false }],
            loading: false,
            loaded: true,
            error: null,
          },
        }}
        compactChains={{}}
        flatFiles={{ root: { entries: [{ name: "example.ts", path: "src/example.ts", fileType: "file", size: 10, mtime: 1, isHidden: false }], loading: false, loaded: true, error: null, truncated: false } }}
        treeViewMode="tree"
        treeFilter=""
        expandedRoots={new Set(["root"])}
        expandedDirs={new Set([rootDirKey("root", "src")])}
        selected={null}
        activeKey={null}
        openFiles={{}}
        gitChangeByRootPath={new Map()}
        onToggleRoot={onToggleRoot}
        onToggleDir={onToggleDir}
        onSelect={onSelect}
        onOpenFile={open}
        onContextMenu={() => {}}
      />
    );

    const file = screen.getByTestId("code-workspace-tree-file");
    // Single click selects only
    fireEvent.click(file);
    expect(onSelect).toHaveBeenCalledWith({ kind: "file", ref: { kind: "root", rootId: "root", path: "src/example.ts" } });
    expect(open).not.toHaveBeenCalled();

    // Double click opens with preview: false
    fireEvent.doubleClick(file);
    expect(open).toHaveBeenCalledWith(
      { kind: "root", rootId: "root", path: "src/example.ts" },
      { preview: false }
    );

    // Loose file
    const loose = screen.getByTestId("code-workspace-tree-loose-file");
    fireEvent.click(loose);
    expect(onSelect).toHaveBeenCalledWith({ kind: "file", ref: { kind: "loose", id: "loose", path: "/outside.txt" } });
    open.mockClear();
    fireEvent.doubleClick(loose);
    expect(open).toHaveBeenCalledWith(
      { kind: "loose", id: "loose", path: "/outside.txt" },
      { preview: false }
    );

    // Directory label: single click selects only; double click toggles
    const dir = screen.getByTestId("code-workspace-tree-dir");
    fireEvent.click(dir);
    expect(onSelect).toHaveBeenCalledWith({ kind: "dir", rootId: "root", path: "src" });
    expect(onToggleDir).not.toHaveBeenCalled();

    fireEvent.doubleClick(dir);
    expect(onToggleDir).toHaveBeenCalledWith("root", "src");

    // Directory chevron arrow: click toggles and selects
    const dirArrow = screen.getByTestId("code-workspace-tree-dir-arrow");
    onToggleDir.mockClear();
    fireEvent.click(dirArrow);
    expect(onToggleDir).toHaveBeenCalledWith("root", "src");

    // Root chevron arrow: click toggles and selects
    const rootArrow = screen.getByTestId("code-workspace-tree-root-arrow");
    fireEvent.click(rootArrow);
    expect(onToggleRoot).toHaveBeenCalledWith("root");
  });

  it("DEC-TOF-01: flat view file single click selects, double click opens with preview: false", () => {
    open.mockClear();
    const onSelect = vi.fn();

    render(
      <ProjectTree
        roots={[{ id: "root", name: "fixture", path: "/fixture", kind: "folder" }]}
        looseFiles={[]}
        directories={{}}
        compactChains={{}}
        flatFiles={{ root: { entries: [{ name: "example.ts", path: "src/example.ts", fileType: "file", size: 10, mtime: 1, isHidden: false }], loading: false, loaded: true, error: null, truncated: false } }}
        treeViewMode="flat"
        treeFilter=""
        expandedRoots={new Set(["root"])}
        expandedDirs={new Set()}
        selected={null}
        activeKey={null}
        openFiles={{}}
        gitChangeByRootPath={new Map()}
        onToggleRoot={vi.fn()}
        onToggleDir={vi.fn()}
        onSelect={onSelect}
        onOpenFile={open}
        onContextMenu={() => {}}
      />
    );

    const flatFile = screen.getByTestId("code-workspace-flat-file");
    fireEvent.click(flatFile);
    expect(onSelect).toHaveBeenCalledWith({ kind: "file", ref: { kind: "root", rootId: "root", path: "src/example.ts" } });
    expect(open).not.toHaveBeenCalled();

    fireEvent.doubleClick(flatFile);
    expect(open).toHaveBeenCalledWith(
      { kind: "root", rootId: "root", path: "src/example.ts" },
      { preview: false }
    );
  });

  it("DEC-TOF-01: double click without prior click selects before opening or toggling", () => {
    open.mockClear();
    const onSelect = vi.fn();
    const onToggleDir = vi.fn();
    const onToggleRoot = vi.fn();

    render(
      <ProjectTree
        roots={[{ id: "root", name: "fixture", path: "/fixture", kind: "folder" }]}
        looseFiles={[{ id: "loose-1", name: "loose.txt", path: "/loose.txt" }]}
        directories={{
          "root:": { entries: [{ name: "src", path: "src", fileType: "dir", size: 0, mtime: 1, isHidden: false }], loading: false, loaded: true, error: null },
          "root:src": { entries: [{ name: "file.ts", path: "src/file.ts", fileType: "file", size: 10, mtime: 1, isHidden: false }], loading: false, loaded: true, error: null },
        }}
        compactChains={{}}
        flatFiles={{}}
        treeViewMode="tree"
        treeFilter=""
        expandedRoots={new Set(["root"])}
        expandedDirs={new Set(["root:src"])}
        selected={null}
        activeKey={null}
        openFiles={{}}
        gitChangeByRootPath={new Map()}
        onToggleRoot={onToggleRoot}
        onToggleDir={onToggleDir}
        onSelect={onSelect}
        onOpenFile={open}
        onContextMenu={() => {}}
      />
    );

    // Direct double-click on file selects and opens
    const file = screen.getByTestId("code-workspace-tree-file");
    fireEvent.doubleClick(file);
    expect(onSelect).toHaveBeenCalledWith({ kind: "file", ref: { kind: "root", rootId: "root", path: "src/file.ts" } });
    expect(open).toHaveBeenCalledWith({ kind: "root", rootId: "root", path: "src/file.ts" }, { preview: false });

    // Direct double-click on dir selects and toggles
    onSelect.mockClear();
    const dir = screen.getByTestId("code-workspace-tree-dir");
    fireEvent.doubleClick(dir);
    expect(onSelect).toHaveBeenCalledWith({ kind: "dir", rootId: "root", path: "src" });
    expect(onToggleDir).toHaveBeenCalledWith("root", "src");

    // Direct double-click on root selects and toggles
    onSelect.mockClear();
    const root = screen.getByTestId("code-workspace-tree-root");
    fireEvent.doubleClick(root);
    expect(onSelect).toHaveBeenCalledWith({ kind: "root", rootId: "root" });
    expect(onToggleRoot).toHaveBeenCalledWith("root");

    // Direct double-click on loose file selects and opens
    onSelect.mockClear();
    open.mockClear();
    const loose = screen.getByTestId("code-workspace-tree-loose-file");
    fireEvent.doubleClick(loose);
    expect(onSelect).toHaveBeenCalledWith({ kind: "file", ref: { kind: "loose", id: "loose-1", path: "/loose.txt" } });
    expect(open).toHaveBeenCalledWith({ kind: "loose", id: "loose-1", path: "/loose.txt" }, { preview: false });
  });
});

