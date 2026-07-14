import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspServerStatus } from "../../../lib/editor/lsp";
import { FileTreePane, type FileTreeViewMode } from "./FileTreePane";
import { TREE_TOOLBAR_MEDIUM_MIN_PX, TREE_TOOLBAR_WIDE_MIN_PX } from "./treeToolbarChrome";

const writeTextMock = vi.fn(async (_text: string) => {});
vi.mock("../../../lib/clipboard", () => ({
  writeText: (text: string) => writeTextMock(text),
}));

const unavailableServer: LspServerStatus = {
  presetId: "typescript",
  displayName: "TypeScript",
  documentLanguageIds: ["typescript"],
  available: false,
  active: false,
  selectedCommandId: "typescript-language-server",
  selectedCommand: null,
  installHint: "npm install -g typescript-language-server",
  error: null,
  commands: [
    {
      id: "typescript-language-server",
      label: "typescript-language-server",
      command: "typescript-language-server",
      args: ["--stdio"],
      installHint: "npm install -g typescript-language-server",
      fallback: false,
      available: false,
    },
  ],
};

function renderPane(overrides: {
  viewMode?: FileTreeViewMode;
  canCreate?: boolean;
  canMutateSelection?: boolean;
  languageOpen?: boolean;
  formatOnSave?: boolean;
  paneWidth?: number;
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
    onLanguageToggle: vi.fn(),
    onLanguageRefresh: vi.fn(),
    onFormatOnSaveChange: vi.fn(),
    onCommandChange: vi.fn(),
    onCustomCommandChange: vi.fn(),
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
      onOpenFile={callbacks.onOpenFile}
      onAddFolder={callbacks.onAddFolder}
      canCreate={overrides.canCreate ?? true}
      canMutateSelection={overrides.canMutateSelection ?? true}
      onCreateFile={callbacks.onCreateFile}
      onCreateDirectory={callbacks.onCreateDirectory}
      onRename={callbacks.onRename}
      onDelete={callbacks.onDelete}
      languageServers={{
        open: overrides.languageOpen ?? false,
        statuses: [unavailableServer],
        activeStatus: null,
        commandPrefs: {},
        customCommands: {},
        customCommandId: "__custom__",
        formatOnSave: overrides.formatOnSave ?? false,
        onToggle: callbacks.onLanguageToggle,
        onRefresh: callbacks.onLanguageRefresh,
        onFormatOnSaveChange: callbacks.onFormatOnSaveChange,
        onCommandChange: callbacks.onCommandChange,
        onCustomCommandChange: callbacks.onCustomCommandChange,
      }}
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

function openMoreMenuAndClick(label: string | RegExp) {
  fireEvent.click(screen.getByTestId("code-workspace-tree-toolbar-more"));
  fireEvent.click(screen.getByRole("button", { name: label }));
}

describe("FileTreePane", () => {
  afterEach(() => cleanup());

  it("uses two fixed-height chrome rows without classic horizontal scrollbar overflow", () => {
    renderPane();
    const toolbar = screen.getByTestId("code-workspace-tree-toolbar");
    const actions = screen.getByTestId("code-workspace-tree-toolbar-actions");
    const browse = screen.getByTestId("code-workspace-tree-toolbar-browse");
    expect(toolbar.className).not.toContain("overflow-x-auto");
    expect(actions.className).toContain("h-[28px]");
    expect(browse.className).toContain("h-[28px]");
    expect(actions.className).not.toMatch(/\bh-9\b/);
  });

  it("keeps Open file and Add folder always visible at wide density", () => {
    const callbacks = renderPane({ paneWidth: TREE_TOOLBAR_WIDE_MIN_PX + 20 });
    expect(screen.getByTestId("code-workspace-tree-pane")).toHaveAttribute(
      "data-tree-toolbar-density",
      "wide",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    fireEvent.click(screen.getByRole("button", { name: "New directory" }));
    expect(callbacks.onOpenFile).toHaveBeenCalledOnce();
    expect(callbacks.onAddFolder).toHaveBeenCalledOnce();
    expect(callbacks.onCreateFile).toHaveBeenCalledOnce();
    expect(callbacks.onCreateDirectory).toHaveBeenCalledOnce();
  });

  it("delegates filter, view, and zoom while Open stays inline", () => {
    const callbacks = renderPane({ paneWidth: TREE_TOOLBAR_WIDE_MIN_PX + 20 });

    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), { target: { value: "lib" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear file filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Flat file view" }));
    fireEvent.click(screen.getByRole("button", { name: "Tree zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));

    expect(callbacks.onFilterChange).toHaveBeenCalledWith("lib");
    expect(callbacks.onFilterChange).toHaveBeenCalledWith("");
    expect(callbacks.onViewModeChange).toHaveBeenCalledWith("flat");
    expect(callbacks.onFontSizeChange).toHaveBeenCalledWith(13);
    expect(callbacks.onOpenFile).toHaveBeenCalledOnce();
    expect(screen.getByText("workspace root")).toBeInTheDocument();
  });

  it("at medium density keeps Open/Add/New file, collapses New directory and zoom into ⋯", () => {
    const callbacks = renderPane({
      paneWidth: (TREE_TOOLBAR_MEDIUM_MIN_PX + TREE_TOOLBAR_WIDE_MIN_PX) / 2,
    });
    expect(screen.getByTestId("code-workspace-tree-pane")).toHaveAttribute(
      "data-tree-toolbar-density",
      "medium",
    );
    expect(screen.getByRole("button", { name: "Open file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New file" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New directory" })).toBeNull();
    expect(screen.queryByTestId("code-workspace-tree-zoom-in")).toBeNull();
    expect(screen.getByTestId("code-workspace-view-tree")).toBeInTheDocument();

    openMoreMenuAndClick("New directory");
    openMoreMenuAndClick("Zoom in");
    expect(callbacks.onCreateDirectory).toHaveBeenCalledOnce();
    expect(callbacks.onFontSizeChange).toHaveBeenCalledWith(13);
  });

  it("at narrow density keeps Open/Add and filter; cycles view; folds create into ⋯", () => {
    const callbacks = renderPane({ paneWidth: TREE_TOOLBAR_MEDIUM_MIN_PX - 20 });
    expect(screen.getByTestId("code-workspace-tree-pane")).toHaveAttribute(
      "data-tree-toolbar-density",
      "narrow",
    );
    expect(screen.getByRole("button", { name: "Open file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Filter files" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New file" })).toBeNull();
    expect(screen.queryByTestId("code-workspace-view-tree")).toBeNull();
    expect(screen.getByTestId("code-workspace-view-cycle")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-view-cycle"));
    expect(callbacks.onViewModeChange).toHaveBeenCalledWith("compact");

    openMoreMenuAndClick("New file");
    openMoreMenuAndClick("Rename");
    expect(callbacks.onCreateFile).toHaveBeenCalledOnce();
    expect(callbacks.onRename).toHaveBeenCalledOnce();
  });

  it("reaches rename/delete through the overflow menu and enforces disabled create", () => {
    const callbacks = renderPane({
      canCreate: false,
      canMutateSelection: false,
      languageOpen: true,
      formatOnSave: true,
      paneWidth: TREE_TOOLBAR_WIDE_MIN_PX + 20,
    });

    expect(screen.getByRole("button", { name: "New file" })).toBeDisabled();
    fireEvent.click(screen.getByTestId("code-workspace-tree-toolbar-more"));
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete or remove" })).toBeDisabled();
    expect(screen.getByText("1 missing")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Format on save" })).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Format on save" }));
    fireEvent.click(screen.getByRole("button", { name: /Language Servers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh language servers" }));
    expect(callbacks.onLanguageToggle).toHaveBeenCalledOnce();
    expect(callbacks.onLanguageRefresh).toHaveBeenCalledOnce();
    expect(callbacks.onFormatOnSaveChange).toHaveBeenCalledWith(false);
  });

  it("copies language-server install instructions to the clipboard", async () => {
    writeTextMock.mockClear();
    renderPane({ languageOpen: true, paneWidth: TREE_TOOLBAR_WIDE_MIN_PX + 20 });
    expect(screen.getByTestId("code-workspace-lsp-install-hint")).toHaveTextContent(
      "npm install -g typescript-language-server",
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy install instructions for TypeScript/ }));
    expect(writeTextMock).toHaveBeenCalledWith("npm install -g typescript-language-server");
  });
});
