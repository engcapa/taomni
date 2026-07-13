import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspServerStatus } from "../../../lib/editor/lsp";
import { FileTreePane, type FileTreeViewMode } from "./FileTreePane";

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
  render(
    <FileTreePane
      paneRef={createRef<HTMLElement>()}
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
  return callbacks;
}

function openMoreMenuAndClick(label: string | RegExp) {
  fireEvent.click(screen.getByTestId("code-workspace-tree-toolbar-more"));
  fireEvent.click(screen.getByRole("button", { name: label }));
}

describe("FileTreePane", () => {
  afterEach(() => cleanup());

  it("delegates filter, view, zoom, and overflow file actions to its owner", () => {
    const callbacks = renderPane();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), { target: { value: "lib" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear file filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Flat file view" }));
    fireEvent.click(screen.getByRole("button", { name: "Tree zoom in" }));
    openMoreMenuAndClick("Open file");
    openMoreMenuAndClick("New directory");

    expect(callbacks.onFilterChange).toHaveBeenCalledWith("lib");
    expect(callbacks.onFilterChange).toHaveBeenCalledWith("");
    expect(callbacks.onViewModeChange).toHaveBeenCalledWith("flat");
    expect(callbacks.onFontSizeChange).toHaveBeenCalledWith(13);
    expect(callbacks.onOpenFile).toHaveBeenCalledOnce();
    expect(callbacks.onCreateDirectory).toHaveBeenCalledOnce();
    expect(screen.getByText("workspace root")).toBeInTheDocument();
  });

  it("keeps a fixed-height toolbar without classic horizontal scrollbar overflow", () => {
    renderPane();
    const toolbar = screen.getByTestId("code-workspace-tree-toolbar");
    expect(toolbar.className).toContain("h-[32px]");
    expect(toolbar.className).not.toContain("overflow-x-auto");
    expect(toolbar.className).not.toMatch(/\bh-9\b/);
    // Primary controls stay inline; lower-frequency actions are behind overflow.
    expect(screen.getByRole("textbox", { name: "Filter files" })).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-view-tree")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-tree-zoom-in")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-tree-toolbar-more")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  });

  it("reaches all prior tree file actions through the overflow menu", () => {
    const callbacks = renderPane();
    openMoreMenuAndClick("Open file");
    openMoreMenuAndClick("Add folder");
    openMoreMenuAndClick("New file");
    openMoreMenuAndClick("New directory");
    openMoreMenuAndClick("Rename");
    openMoreMenuAndClick("Delete or remove");

    expect(callbacks.onOpenFile).toHaveBeenCalledOnce();
    expect(callbacks.onAddFolder).toHaveBeenCalledOnce();
    expect(callbacks.onCreateFile).toHaveBeenCalledOnce();
    expect(callbacks.onCreateDirectory).toHaveBeenCalledOnce();
    expect(callbacks.onRename).toHaveBeenCalledOnce();
    expect(callbacks.onDelete).toHaveBeenCalledOnce();
  });

  it("enforces tree action availability and exposes language server controls", () => {
    const callbacks = renderPane({
      canCreate: false,
      canMutateSelection: false,
      languageOpen: true,
      formatOnSave: true,
    });

    fireEvent.click(screen.getByTestId("code-workspace-tree-toolbar-more"));
    expect(screen.getByRole("button", { name: "New file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(screen.getByText("1 missing")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("npm install -g typescript-language-server")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Format on save" })).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Format on save" }));
    fireEvent.click(screen.getByRole("button", { name: /Language Servers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh language servers" }));
    expect(callbacks.onLanguageToggle).toHaveBeenCalledOnce();
    expect(callbacks.onLanguageRefresh).toHaveBeenCalledOnce();
    expect(callbacks.onFormatOnSaveChange).toHaveBeenCalledWith(false);
  });
});
