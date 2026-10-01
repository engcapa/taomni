import { createRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTreePane, type FileTreeViewMode } from "./FileTreePane";
import { TREE_TOOLBAR_MEDIUM_MIN_PX, TREE_TOOLBAR_WIDE_MIN_PX } from "./treeToolbarChrome";

function renderPane(overrides: {
  viewMode?: FileTreeViewMode;
  canCreate?: boolean;
  canMutateSelection?: boolean;
  paneWidth?: number;
  onToggleCollapse?: () => void;
  onExpandAll?: () => void;
  onShowDetailsChange?: (value: boolean) => void;
} = {}) {
  const callbacks = {
    onFilterChange: vi.fn(),
    onViewModeChange: vi.fn(),
    onFontSizeChange: vi.fn(),
    onOpenFile: vi.fn(),
    onAddFolder: vi.fn(),
    onCreateFile: vi.fn(),
    onCreateDirectory: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onToggleCollapse: overrides.onToggleCollapse ?? vi.fn(),
  };
  const paneRef = createRef<HTMLElement>();
  render(
    <FileTreePane
      paneRef={paneRef}
      style={{}}
      filter="src"
      onFilterChange={callbacks.onFilterChange}
      viewMode={overrides.viewMode ?? "tree"}
      onViewModeChange={callbacks.onViewModeChange}
      fontSize={12}
      minFontSize={10}
      maxFontSize={20}
      defaultFontSize={12}
      onFontSizeChange={callbacks.onFontSizeChange}
      onToggleCollapse={callbacks.onToggleCollapse}
      onOpenFile={callbacks.onOpenFile}
      onAddFolder={callbacks.onAddFolder}
      canCreate={overrides.canCreate ?? true}
      canMutateSelection={overrides.canMutateSelection ?? true}
      onCreateFile={callbacks.onCreateFile}
      onCreateDirectory={callbacks.onCreateDirectory}
      onRename={callbacks.onRename}
      onDelete={callbacks.onDelete}
      onExpandAll={overrides.onExpandAll}
      onShowDetailsChange={overrides.onShowDetailsChange}
    >
      <button type="button">workspace root</button>
    </FileTreePane>,
  );

  const width = overrides.paneWidth ?? TREE_TOOLBAR_WIDE_MIN_PX + 40;
  const pane = screen.getByTestId("code-workspace-tree-pane");
  pane.getBoundingClientRect = () => ({
    width,
    height: 400,
    top: 0,
    left: 0,
    bottom: 400,
    right: width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  return callbacks;
}

function openMenu(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
}

function SpeedSearchHarness() {
  const [filter, setFilter] = useState("");
  const paneRef = createRef<HTMLElement>();
  return (
    <FileTreePane
      paneRef={paneRef}
      style={{}}
      filter={filter}
      onFilterChange={setFilter}
      viewMode="tree"
      onViewModeChange={vi.fn()}
      fontSize={12}
      minFontSize={10}
      maxFontSize={20}
      defaultFontSize={12}
      onFontSizeChange={vi.fn()}
      onOpenFile={vi.fn()}
      onAddFolder={vi.fn()}
      canCreate
      canMutateSelection
      onCreateFile={vi.fn()}
      onCreateDirectory={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    >
      <button type="button" role="treeitem" data-tree-kind="root" data-selected="true">workspace root</button>
    </FileTreePane>
  );
}

describe("FileTreePane", () => {
  afterEach(() => cleanup());

  it("renders IDEA's single title row: Project ▾, New, Options and Hide", () => {
    renderPane();
    const toolbar = screen.getByTestId("code-workspace-tree-toolbar");
    const actions = screen.getByTestId("code-workspace-tree-toolbar-actions");
    expect(toolbar.className).not.toContain("overflow-x-auto");
    expect(actions.className).toContain("h-[30px]");
    expect(screen.queryByTestId("code-workspace-tree-toolbar-browse")).toBeNull();
    expect(screen.getByTestId("code-workspace-tree-view-selector")).toHaveTextContent("Project");
    const order = Array.from(actions.querySelectorAll("button")).map((button) => button.getAttribute("data-testid"));
    expect(order).toEqual([
      "code-workspace-tree-view-selector",
      "code-workspace-tree-new",
      "code-workspace-tree-toolbar-more",
      "code-workspace-tree-collapse",
    ]);
    // No permanent Open/Add/New buttons: they live under New (+).
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add folder" })).toBeNull();
  });

  it("New (+) offers File, Directory, Open File… and Add Folder to Workspace…", () => {
    const callbacks = renderPane();
    openMenu("code-workspace-tree-new");
    fireEvent.click(screen.getByTestId("code-workspace-tree-new-file"));
    openMenu("code-workspace-tree-new");
    fireEvent.click(screen.getByTestId("code-workspace-tree-new-directory"));
    openMenu("code-workspace-tree-new");
    fireEvent.click(screen.getByTestId("code-workspace-tree-open-file"));
    openMenu("code-workspace-tree-new");
    fireEvent.click(screen.getByTestId("code-workspace-tree-add-folder"));
    expect(callbacks.onCreateFile).toHaveBeenCalledOnce();
    expect(callbacks.onCreateDirectory).toHaveBeenCalledOnce();
    expect(callbacks.onOpenFile).toHaveBeenCalledOnce();
    expect(callbacks.onAddFolder).toHaveBeenCalledOnce();
  });

  it("switches between the Project and Project Files views from the title selector", () => {
    const callbacks = renderPane();
    openMenu("code-workspace-tree-view-selector");
    expect(screen.getByTestId("code-workspace-tree-view-project")).toHaveTextContent("✓");
    expect(screen.getByTestId("code-workspace-tree-view-project-files")).not.toHaveTextContent("✓");
    fireEvent.click(screen.getByTestId("code-workspace-tree-view-project-files"));
    expect(callbacks.onViewModeChange).toHaveBeenCalledWith("flat");
    cleanup();
    const flat = renderPane({ viewMode: "flat" });
    expect(screen.getByTestId("code-workspace-tree-view-selector")).toHaveTextContent("Project Files");
    openMenu("code-workspace-tree-view-selector");
    fireEvent.click(screen.getByTestId("code-workspace-tree-view-project"));
    expect(flat.onViewModeChange).toHaveBeenCalledWith("tree");
  });

  it("Options › Appearance holds Details, Compact Directories and the tree zoom", () => {
    const onShowDetailsChange = vi.fn();
    const callbacks = renderPane({ onShowDetailsChange });
    const appearance = () => {
      openMenu("code-workspace-tree-toolbar-more");
      fireEvent.click(screen.getByTestId("code-workspace-tree-menu-appearance"));
    };
    appearance();
    fireEvent.click(screen.getByTestId("code-workspace-tree-menu-compact"));
    expect(callbacks.onViewModeChange).toHaveBeenCalledWith("compact");
    appearance();
    fireEvent.click(screen.getByTestId("code-workspace-tree-zoom-in"));
    expect(callbacks.onFontSizeChange).toHaveBeenCalledWith(13);
    appearance();
    fireEvent.click(screen.getByTestId("code-workspace-tree-zoom-out"));
    expect(callbacks.onFontSizeChange).toHaveBeenCalledWith(11);
    appearance();
    expect(screen.getByTestId("code-workspace-tree-zoom-reset")).toBeDisabled();
    fireEvent.click(screen.getByTestId("code-workspace-tree-menu-details"));
    expect(onShowDetailsChange).toHaveBeenCalledWith(true);
  });

  it("at narrow density folds Expand All into Options", () => {
    const onExpandAll = vi.fn();
    renderPane({ paneWidth: TREE_TOOLBAR_MEDIUM_MIN_PX - 20, onExpandAll });
    expect(screen.getByTestId("code-workspace-tree-pane")).toHaveAttribute("data-tree-toolbar-density", "narrow");
    expect(screen.queryByTestId("code-workspace-tree-expand-all")).toBeNull();
    openMenu("code-workspace-tree-toolbar-more");
    fireEvent.click(screen.getByTestId("code-workspace-tree-menu-expand-all"));
    expect(onExpandAll).toHaveBeenCalledOnce();
  });

  it("disables File/Directory without a target folder and Rename/Delete without a selection", () => {
    renderPane({ canCreate: false, canMutateSelection: false });
    openMenu("code-workspace-tree-new");
    expect(screen.getByTestId("code-workspace-tree-new-file")).toBeDisabled();
    expect(screen.getByTestId("code-workspace-tree-new-directory")).toBeDisabled();
    expect(screen.getByTestId("code-workspace-tree-add-folder")).toBeEnabled();
    fireEvent.keyDown(document, { key: "Escape" });
    openMenu("code-workspace-tree-toolbar-more");
    expect(screen.getByRole("button", { name: "Rename…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete…" })).toBeDisabled();
    // Language Servers live in Settings now — not in every workspace tree.
    expect(screen.queryByText("Language Servers")).toBeNull();
  });

  it("opens IDEA speed search by typing in the tree and closes it with Esc", () => {
    render(<SpeedSearchHarness />);
    expect(screen.queryByTestId("code-workspace-tree-speed-search")).toBeNull();
    const row = screen.getByRole("treeitem", { name: "workspace root" });
    row.focus();
    fireEvent.keyDown(row, { key: "m" });
    const input = screen.getByTestId("code-workspace-tree-filter");
    expect(input).toHaveValue("m");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "main" } });
    expect(input).toHaveValue("main");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("code-workspace-tree-speed-search")).toBeNull();
    expect(row).toHaveFocus();
    // Ctrl+F opens an empty search; the close button clears it.
    fireEvent.keyDown(row, { key: "f", ctrlKey: true });
    expect(screen.getByTestId("code-workspace-tree-filter")).toHaveValue("");
    fireEvent.click(screen.getByTestId("code-workspace-tree-speed-search-close"));
    expect(screen.queryByTestId("code-workspace-tree-speed-search")).toBeNull();
  });

  it("offers IDEA's Project header actions and the tool window options", () => {
    const onSelectOpenedFile = vi.fn();
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    const onMove = vi.fn();
    const paneRef = createRef<HTMLElement>();
    render(
      <FileTreePane
        paneRef={paneRef}
        style={{}}
        filter=""
        onFilterChange={vi.fn()}
        viewMode="tree"
        onViewModeChange={vi.fn()}
        fontSize={12}
        minFontSize={10}
        maxFontSize={20}
        defaultFontSize={12}
        onFontSizeChange={vi.fn()}
        onOpenFile={vi.fn()}
        onAddFolder={vi.fn()}
        canCreate
        canMutateSelection
        onCreateFile={vi.fn()}
        onCreateDirectory={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onSelectOpenedFile={onSelectOpenedFile}
        onExpandAll={onExpandAll}
        onCollapseAll={onCollapseAll}
        toolWindowOptions={() => [{ label: "Move to", testId: "tool-window-move", onClick: onMove }]}
      >
        <button type="button">workspace root</button>
      </FileTreePane>,
    );
    const pane = screen.getByTestId("code-workspace-tree-pane");
    const width = TREE_TOOLBAR_WIDE_MIN_PX + 40;
    pane.getBoundingClientRect = () => ({
      width, height: 400, top: 0, left: 0, bottom: 400, right: width, x: 0, y: 0, toJSON: () => ({}),
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    fireEvent.click(screen.getByTestId("code-workspace-tree-select-opened"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-expand-all"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-collapse-all"));
    expect(onSelectOpenedFile).toHaveBeenCalledOnce();
    expect(onExpandAll).toHaveBeenCalledOnce();
    expect(onCollapseAll).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("code-workspace-tree-toolbar-more"));
    fireEvent.click(screen.getByTestId("tool-window-move"));
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("places a panel-local collapse control on the tree toolbar row", () => {
    const onToggleCollapse = vi.fn();
    renderPane({ onToggleCollapse });

    const collapse = screen.getByTestId("code-workspace-tree-collapse");
    expect(collapse).toHaveAttribute("aria-label", "Hide (Shift+Escape)");
    fireEvent.click(collapse);
    expect(onToggleCollapse).toHaveBeenCalledOnce();
  });
});
