import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEverywhere, actionMatchesQuery, rankAllModeItems, type GoToFileItem } from "./SearchEverywhere";
import { searchEverywhereTabDirection } from "./QuickPickOverlay";
import { setKeymapPlatformOverride } from "./workspaceKeymapPlatform";
import type { ActionSnapshotItem, PreparedActionEvaluation } from "./workspaceActionHost";
import { createWorkspaceSemanticIndexSnapshot } from "./workspaceSemanticIndex";

const items: GoToFileItem[] = [
  { rootId: "root-1", rootName: "app", path: "src/components/editor/CodeWorkspaceTab.tsx" },
  { rootId: "root-1", rootName: "app", path: "src/lib/editor/workspace.ts" },
  { rootId: "root-2", rootName: "tools", path: "scripts/deploy.sh" },
];
/** Snapshot-only fixture (§8.17.3): the commands array input is gone. */
const actionSnapshots: ActionSnapshotItem[] = [
  {
    id: "workspace.findInFiles",
    title: "Find in Files",
    category: "Search",
    keybinding: "Ctrl+Shift+F",
    keybindings: ["Ctrl+Shift+F"],
    keywords: ["content", "grep"],
    state: {
      availability: "available",
      disabledReason: undefined,
      source: "local",
      scope: "workspace",
      freshness: "current",
      completeness: "complete",
    },
    evaluation: {} as unknown as PreparedActionEvaluation,
  },
];

function renderPopup(overrides: Partial<Parameters<typeof SearchEverywhere>[0]> = {}) {
  const onOpenFile = vi.fn();
  const onClose = vi.fn();
  const onRunCommand = vi.fn();
  render(
    <SearchEverywhere
      open
      items={items}
      loading={false}
      actionSnapshots={actionSnapshots}
      onClose={onClose}
      onOpenFile={onOpenFile}
      onRunCommand={onRunCommand}
      {...overrides}
    />,
  );
  return { onOpenFile, onClose, onRunCommand };
}

describe("SearchEverywhere", () => {
  afterEach(() => cleanup());

  it("switches category tabs with Tab and Shift+Tab like IDEA (SearchEverywhere.NextTab)", () => {
    renderPopup({ initialMode: "files" });
    const input = screen.getByLabelText("Go to file");
    expect(screen.getByTestId("search-everywhere-tab-files")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.getByTestId("search-everywhere-tab-symbols")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByLabelText("Go to symbol"), { key: "Tab", shiftKey: true });
    fireEvent.keyDown(screen.getByLabelText("Go to file"), { key: "Tab", shiftKey: true });
    expect(screen.getByTestId("search-everywhere-tab-classes")).toHaveAttribute("aria-selected", "true");
    // Plain Left/Right keep moving the caret in the query.
    fireEvent.keyDown(screen.getByLabelText("Go to class"), { key: "ArrowRight" });
    expect(screen.getByTestId("search-everywhere-tab-classes")).toHaveAttribute("aria-selected", "true");
  });

  it("switches tabs with Alt+Left/Right and Ctrl+Tab like IDEA (NextTab / PreviousTab / Switcher)", () => {
    setKeymapPlatformOverride("linux");
    try {
      renderPopup({ initialMode: "classes" });
      fireEvent.keyDown(screen.getByLabelText("Go to class"), { key: "ArrowRight", altKey: true });
      expect(screen.getByTestId("search-everywhere-tab-files")).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(screen.getByLabelText("Go to file"), { key: "ArrowRight", altKey: true });
      expect(screen.getByTestId("search-everywhere-tab-symbols")).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(screen.getByLabelText("Go to symbol"), { key: "ArrowLeft", altKey: true });
      expect(screen.getByTestId("search-everywhere-tab-files")).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(screen.getByLabelText("Go to file"), { key: "Tab", ctrlKey: true });
      expect(screen.getByTestId("search-everywhere-tab-symbols")).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(screen.getByLabelText("Go to symbol"), { key: "Tab", ctrlKey: true, shiftKey: true });
      expect(screen.getByTestId("search-everywhere-tab-files")).toHaveAttribute("aria-selected", "true");
      // Wraps from the first tab to the last.
      fireEvent.keyDown(screen.getByLabelText("Go to file"), { key: "ArrowLeft", altKey: true });
      fireEvent.keyDown(screen.getByLabelText("Go to class"), { key: "ArrowLeft", altKey: true });
      fireEvent.keyDown(screen.getByLabelText("Search everywhere"), { key: "ArrowLeft", altKey: true });
      expect(screen.getByTestId("search-everywhere-tab-text")).toHaveAttribute("aria-selected", "true");
    } finally {
      setKeymapPlatformOverride(null);
    }
  });

  it("maps the macOS NextTab chords (Ctrl+Right, Cmd+Shift+]) and keeps Option+arrows for the caret", () => {
    expect(searchEverywhereTabDirection({ key: "ArrowRight", code: "ArrowRight", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, "mac")).toBe(1);
    expect(searchEverywhereTabDirection({ key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, "mac")).toBe(-1);
    expect(searchEverywhereTabDirection({ key: "}", code: "BracketRight", ctrlKey: false, altKey: false, shiftKey: true, metaKey: true }, "mac")).toBe(1);
    expect(searchEverywhereTabDirection({ key: "{", code: "BracketLeft", ctrlKey: false, altKey: false, shiftKey: true, metaKey: true }, "mac")).toBe(-1);
    expect(searchEverywhereTabDirection({ key: "ArrowRight", code: "ArrowRight", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }, "mac")).toBeNull();
    expect(searchEverywhereTabDirection({ key: "ArrowRight", code: "ArrowRight", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, "windows")).toBeNull();
    expect(searchEverywhereTabDirection({ key: "ArrowRight", code: "ArrowRight", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }, "windows")).toBe(1);
    expect(searchEverywhereTabDirection({ key: "ArrowRight", code: "ArrowRight", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, "linux")).toBeNull();
  });

  it("jumps to the last/first result with PageDown/PageUp and Ctrl+Down/Up (NavigateToNextGroup)", () => {
    renderPopup({ initialMode: "files" });
    const input = screen.getByLabelText("Go to file");
    const rows = () => Array.from(document.querySelectorAll("[data-testid='code-workspace-search-everywhere'] [data-index]"));
    const selectedIndex = () => rows().findIndex((row) => row.getAttribute("data-selected") === "true");
    expect(rows()).toHaveLength(3);
    expect(selectedIndex()).toBe(0);
    fireEvent.keyDown(input, { key: "PageDown" });
    expect(selectedIndex()).toBe(2);
    fireEvent.keyDown(input, { key: "PageUp" });
    expect(selectedIndex()).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowDown", ctrlKey: true });
    expect(selectedIndex()).toBe(2);
    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });
    expect(selectedIndex()).toBe(0);
  });

  it("reopens with an empty query even when the previous query was typed", () => {
    const props = {
      items,
      loading: false,
      actionSnapshots,
      onClose: vi.fn(),
      onOpenFile: vi.fn(),
      onRunCommand: vi.fn(),
      initialMode: "actions" as const,
    };
    const { rerender } = render(<SearchEverywhere open {...props} />);
    fireEvent.change(screen.getByLabelText("Search actions"), { target: { value: "Find in" } });
    expect(screen.getByLabelText("Search actions")).toHaveValue("Find in");
    rerender(<SearchEverywhere open={false} {...props} />);
    rerender(<SearchEverywhere open {...props} />);
    expect(screen.getByLabelText("Search actions")).toHaveValue("");
    expect(screen.getByText("Find in Files")).toBeInTheDocument();
  });

  it("renders nothing while closed", () => {
    renderPopup({ open: false });
    expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
  });

  it("filters files with camelCase abbreviations and opens the selection", () => {
    const { onOpenFile } = renderPopup();
    const input = screen.getByLabelText("Go to file");

    fireEvent.change(input, { target: { value: "cwt" } });
    expect(screen.getByText("CodeWorkspaceTab.tsx")).toBeInTheDocument();
    expect(screen.queryByText("deploy.sh")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");
    expect(screen.getByText("deploy.sh")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "cwt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith(items[0]);
  });

  it("moves the selection with arrow keys before opening", () => {
    const { onOpenFile } = renderPopup();
    const input = screen.getByLabelText("Go to file");

    fireEvent.change(input, { target: { value: "editor" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    const opened = onOpenFile.mock.calls[0][0] as GoToFileItem;
    const shown = screen.getAllByRole("button").map((button) => button.textContent);
    expect(shown.some((text) => text?.includes(opened.path.split("/").pop() ?? ""))).toBe(true);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("requests a split open with Ctrl+Enter", () => {
    const { onOpenFile } = renderPopup();
    fireEvent.keyDown(screen.getByLabelText("Go to file"), { key: "Enter", ctrlKey: true });
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ rootId: expect.any(String) }), { split: true });
  });

  it("closes on Escape and on backdrop clicks", () => {
    const { onClose } = renderPopup();
    fireEvent.keyDown(screen.getByLabelText("Go to file"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId("code-workspace-search-everywhere"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("reports the index size and truncation", () => {
    renderPopup({ truncated: true });
    expect(screen.getByText(/file index truncated · 3 files/)).toBeInTheDocument();
  });

  it("shows an indexing hint while loading with no results", () => {
    renderPopup({ items: [], loading: true });
    expect(screen.getByText("Indexing workspace files...")).toBeInTheDocument();
  });

  it("searches and runs commands from the Actions tab", () => {
    const { onRunCommand } = renderPopup();
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    const input = screen.getByLabelText("Search actions");
    fireEvent.change(input, { target: { value: "grep" } });
    expect(screen.getByText("Find in Files")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Shift+F")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunCommand).toHaveBeenCalledWith("workspace.findInFiles");
  });

  it("treats an explicitly supplied empty snapshot as authoritative", () => {
    renderPopup({ actionSnapshots: [], initialMode: "actions" });
    expect(screen.getByText("No available workspace actions")).toBeInTheDocument();
    expect(screen.queryByText("Find in Files")).not.toBeInTheDocument();
  });

  it("does not expose disabled snapshot actions as selectable results", () => {
    renderPopup({
      actionSnapshots: [{
        id: "workspace.findInFiles",
        title: "Find in Files",
        category: "Search",
        keybinding: "Ctrl+Shift+F",
        state: {
          availability: "disabled",
          disabledReason: "providerOffline",
          source: "provider",
          scope: "workspace",
          freshness: "current",
          completeness: "unavailable",
        },
        evaluation: {} as never,
      }],
      initialMode: "actions",
    });
    expect(screen.getByText("No available workspace actions")).toBeInTheDocument();
    expect(screen.queryByText("Find in Files")).not.toBeInTheDocument();
  });

  it("shows Classes/Symbols when available and routes Text into Find in Files", async () => {
    const onSearchText = vi.fn();
    const onOpenSymbol = vi.fn();
    const fetchSymbols = vi.fn(async () => ({
      symbols: [{
        name: "CodeWorkspaceTab",
        kind: 5,
        containerName: "editor",
        path: "src/CodeWorkspaceTab.tsx",
        uri: "file:///repo/src/CodeWorkspaceTab.tsx",
        line: 10,
        character: 0,
        resolved: true,
        resolveToken: null,
      }],
      semanticGeneration: 3,
      semanticRevision: 4,
      sessionCount: 1,
      providerCount: 1,
      skippedProviderCount: 0,
      failedProviderCount: 0,
      complete: true,
      truncated: false,
      diagnostics: [],
    }));
    renderPopup({
      symbolsAvailable: true,
      semanticIndex: createWorkspaceSemanticIndexSnapshot(),
      fetchSymbols,
      onSearchText,
      onOpenSymbol,
      initialMode: "classes",
    });
    expect(screen.getByRole("tab", { name: "Classes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Symbols" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Go to class"), { target: { value: "CWT" } });
    expect(await screen.findByText("CodeWorkspaceTab")).toBeInTheDocument();
    // ED-PARITY-014 DEC-014-02: diagnostics moved from the footer text into the tooltip.
    const status = screen.getByTestId("search-everywhere-symbol-provider-status");
    expect(status.getAttribute("title")).toContain("Stale · result generation 3");
    expect(status.getAttribute("title")).toContain("1/1 provider");
    expect(status).toHaveTextContent("");
    fireEvent.keyDown(screen.getByLabelText("Go to class"), { key: "Enter" });
    expect(onOpenSymbol).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    fireEvent.change(screen.getByLabelText("Find in files"), { target: { value: "needle" } });
    fireEvent.keyDown(screen.getByLabelText("Find in files"), { key: "Enter" });
    expect(onSearchText).toHaveBeenCalledWith("needle");
  });

  it("does not display a fabricated first line for unresolved workspace symbols", async () => {
    const onOpenSymbol = vi.fn();
    const fetchSymbols = vi.fn(async () => ({
      symbols: [{
        name: "DeferredType",
        kind: 5,
        containerName: "editor",
        path: "src/deferred.ts",
        uri: "file:///repo/src/deferred.ts",
        line: 0,
        character: 0,
        resolved: false,
        resolveToken: "0123456789abcdef0123456789abcdef:0",
      }],
      semanticGeneration: 1,
      semanticRevision: 0,
      sessionCount: 1,
      providerCount: 1,
      skippedProviderCount: 0,
      failedProviderCount: 0,
      complete: true,
      truncated: false,
      diagnostics: [],
    }));
    renderPopup({
      symbolsAvailable: true,
      fetchSymbols,
      onOpenSymbol,
      initialMode: "symbols",
    });

    fireEvent.change(screen.getByLabelText("Go to symbol"), { target: { value: "Deferred" } });
    expect(await screen.findByText("DeferredType")).toBeInTheDocument();
    expect(screen.getByText("editor · src/deferred.ts")).toBeInTheDocument();
    expect(screen.queryByText("editor · src/deferred.ts:1")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText("Go to symbol"), { key: "Enter" });
    expect(onOpenSymbol).toHaveBeenCalledWith(expect.objectContaining({
      resolved: false,
      resolveToken: "0123456789abcdef0123456789abcdef:0",
    }));
  });

  it("handles fetchSymbols with undefined diagnostics without crashing", async () => {
    const fetchSymbols = vi.fn(async () => ({
      symbols: [{
        name: "TestSymbol",
        kind: 5,
        containerName: "editor",
        path: "src/test.ts",
        uri: "file:///repo/src/test.ts",
        line: 0,
        character: 0,
        resolved: true,
        resolveToken: null,
      }],
      semanticGeneration: 1,
      semanticRevision: 0,
      sessionCount: 1,
      providerCount: 1,
      skippedProviderCount: 0,
      failedProviderCount: 0,
      complete: true,
      truncated: false,
      diagnostics: undefined as unknown as string[],
    }));

    renderPopup({
      symbolsAvailable: true,
      fetchSymbols,
      initialMode: "symbols",
    });

    fireEvent.change(screen.getByLabelText("Go to symbol"), { target: { value: "Test" } });
    expect(await screen.findByText("TestSymbol")).toBeInTheDocument();
    expect(screen.getByTestId("search-everywhere-symbol-provider-status")).toBeInTheDocument();
  });
});

describe("ED-PARITY-014: Search Everywhere All ranking", () => {
  afterEach(() => cleanup());
  const action = (id: string, title: string, keywords: string[] = []) => ({
    kind: "action" as const,
    value: { ...actionSnapshots[0], id, title, keywords },
  });
  const symbol = (name: string) => ({
    kind: "symbol" as const,
    value: {
      name, kind: 6, containerName: "OrderService", path: "src/OrderService.java", uri: "file:///src/OrderService.java",
      line: 9, character: 4, resolved: true, resolveToken: null,
    },
  });

  it("drops actions whose words do not contain the query", () => {
    expect(actionMatchesQuery("total", { title: "Move to Line Start", keywords: ["caret"] })).toBe(false);
    expect(actionMatchesQuery("line start", { title: "Move to Line Start", keywords: [] })).toBe(true);
    expect(actionMatchesQuery("grep", { title: "Find in Files", keywords: ["content", "grep"] })).toBe(true);
  });

  it("lists symbols, then files, then matching actions", () => {
    const ranked = rankAllModeItems("total", [
      action("move", "Move to Line Start"),
      action("totals", "Show Totals"),
      { kind: "file" as const, value: { rootId: "r", rootName: "app", path: "src/Totals.java" } },
      symbol("total"),
    ]);
    expect(ranked.map((item) => item.kind)).toEqual(["symbol", "file", "action"]);
    expect(ranked.some((item) => item.kind === "action" && item.value.id === "move")).toBe(false);
  });

  it("shows the selected item's path in the footer", () => {
    renderPopup();
    fireEvent.change(screen.getByLabelText("Go to file"), { target: { value: "cwt" } });
    expect(screen.getByTestId("search-everywhere-selected-path")).toHaveTextContent("app/src/components/editor/CodeWorkspaceTab.tsx");
  });
});
