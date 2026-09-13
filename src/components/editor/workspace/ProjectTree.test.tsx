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
});
