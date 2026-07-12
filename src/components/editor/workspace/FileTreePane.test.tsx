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
        onToggle: callbacks.onLanguageToggle,
        onRefresh: callbacks.onLanguageRefresh,
        onCommandChange: callbacks.onCommandChange,
        onCustomCommandChange: callbacks.onCustomCommandChange,
      }}
    >
      <button type="button">workspace root</button>
    </FileTreePane>,
  );
  return callbacks;
}

describe("FileTreePane", () => {
  afterEach(() => cleanup());

  it("delegates filter, view, zoom, and file actions to its owner", () => {
    const callbacks = renderPane();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), { target: { value: "lib" } });
    fireEvent.click(screen.getByRole("button", { name: "Flat file view" }));
    fireEvent.click(screen.getByRole("button", { name: "Tree zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    fireEvent.click(screen.getByRole("button", { name: "New directory" }));

    expect(callbacks.onFilterChange).toHaveBeenCalledWith("lib");
    expect(callbacks.onViewModeChange).toHaveBeenCalledWith("flat");
    expect(callbacks.onFontSizeChange).toHaveBeenCalledWith(13);
    expect(callbacks.onOpenFile).toHaveBeenCalledOnce();
    expect(callbacks.onCreateDirectory).toHaveBeenCalledOnce();
    expect(screen.getByText("workspace root")).toBeInTheDocument();
  });

  it("enforces tree action availability and exposes language server controls", () => {
    const callbacks = renderPane({ canCreate: false, canMutateSelection: false, languageOpen: true });

    expect(screen.getByRole("button", { name: "New file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(screen.getByText("1 missing")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("npm install -g typescript-language-server")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Language Servers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh language servers" }));
    expect(callbacks.onLanguageToggle).toHaveBeenCalledOnce();
    expect(callbacks.onLanguageRefresh).toHaveBeenCalledOnce();
  });
});
