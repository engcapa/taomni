import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectTree, type ProjectTreeProps } from "./ProjectTree";
import { navigateProjectTree } from "./projectTreeNavigation";
import { rootDirKey, type TreeSelection } from "./codeWorkspaceModel";
import { FileTreePane } from "./FileTreePane";

const open = vi.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
const entries = Array.from({ length: 500 }, (_, index) => ({
  name: `item-${String(index).padStart(3, "0")}.txt`, path: `item-${String(index).padStart(3, "0")}.txt`,
  fileType: "file" as const, size: index, mtime: index, isHidden: false,
}));

beforeEach(() => {
  open.mockClear();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "tree" ? 240 : 28;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(14028);
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: function (this: Element, options: ScrollToOptions | number) {
    this.scrollTop = typeof options === "number" ? options : options.top ?? 0;
    this.dispatchEvent(new Event("scroll"));
  } });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  if (originalScrollTo) Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(Element.prototype, "scrollTo");
});

function Harness({ mode = "tree", filter = "" }: { mode?: ProjectTreeProps["treeViewMode"]; filter?: string }) {
  const paneRef = useRef<HTMLElement>(null);
  const [selected, onSelect] = useState<TreeSelection | null>(null);
  const onToggleRoot = vi.fn();
  const onToggleDir = vi.fn();
  return <FileTreePane paneRef={paneRef} style={{}} filter={filter} onFilterChange={() => {}}
    viewMode={mode} onViewModeChange={() => {}} fontSize={12} minFontSize={10} maxFontSize={20}
    defaultFontSize={12} onFontSizeChange={() => {}} onOpenFile={() => {}} onAddFolder={() => {}}
    canCreate canMutateSelection onCreateFile={() => {}} onCreateDirectory={() => {}} onRename={() => {}} onDelete={() => {}}
    onKeyDown={(event) => {
    const tree = paneRef.current!.querySelector<HTMLElement>('[data-testid="code-workspace-tree"]')!;
    if (navigateProjectTree(tree, event.key, { onSelect, onToggleRoot, onToggleDir })) event.preventDefault();
  }}>
    <ProjectTree roots={[{ id: "root", name: "fixture", path: "/fixture", kind: "folder" }]} looseFiles={[]}
      directories={{ [rootDirKey("root", "")]: { entries, loaded: true, loading: false, error: null } }} compactChains={{}}
      flatFiles={{ root: { entries, loaded: true, loading: false, error: null, truncated: false } }}
      treeViewMode={mode} treeFilter={filter} expandedRoots={new Set(["root"])} expandedDirs={new Set()}
      selected={selected} activeKey={null} openFiles={{}} gitChangeByRootPath={new Map()}
      onToggleRoot={onToggleRoot} onToggleDir={onToggleDir} onSelect={onSelect} onOpenFile={open} onContextMenu={() => {}} />
  </FileTreePane>;
}

it.each(["tree", "list", "files"] as const)("keeps %s rows bounded and navigates to offscreen items without opening them", async (mode) => {
  render(<Harness mode={mode} />);
  const tree = screen.getByRole("tree");
  expect(screen.getByTestId("code-workspace-tree-viewport")).toHaveAttribute("data-row-count", "501");
  expect(screen.getAllByRole("treeitem").length).toBeLessThan(40);
  expect(screen.queryByText("item-499.txt")).not.toBeInTheDocument();
  const pane = screen.getByTestId("code-workspace-tree-pane");
  act(() => pane.focus());
  fireEvent.keyDown(pane, { key: "End" });
  await waitFor(() => expect(screen.getByText("item-499.txt").closest("button")).toHaveFocus());
  expect(screen.getByText("item-499.txt").closest("button")).toHaveAttribute("aria-selected", "true");
  expect(open).not.toHaveBeenCalled();
  fireEvent.keyDown(tree, { key: "ArrowUp" });
  await waitFor(() => expect(screen.getByText("item-498.txt").closest("button")).toHaveFocus());
  fireEvent.doubleClick(screen.getByText("item-498.txt"));
  expect(open).toHaveBeenCalledWith({ kind: "root", rootId: "root", path: "item-498.txt" }, { preview: false });
  fireEvent.keyDown(tree, { key: "Home" });
  await waitFor(() => expect(screen.getByTestId("code-workspace-tree-root")).toHaveFocus());
  expect(screen.getAllByRole("treeitem").length).toBeLessThan(40);
});

it("returns from a scrolled viewport to a short filtered result without retaining stale navigation", async () => {
  const rendered = render(<Harness />);
  const tree = screen.getByRole("tree");
  act(() => tree.focus());
  fireEvent.keyDown(tree, { key: "End" });
  await waitFor(() => expect(screen.getByText("item-499.txt").closest("button")).toHaveFocus());
  rendered.rerender(<Harness filter="item-025" />);
  expect(screen.queryByTestId("code-workspace-tree-viewport")).not.toBeInTheDocument();
  expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  fireEvent.keyDown(tree, { key: "End" });
  expect(screen.getByText("item-025.txt").closest("button")).toHaveAttribute("aria-selected", "true");
  expect(open).not.toHaveBeenCalled();
});
