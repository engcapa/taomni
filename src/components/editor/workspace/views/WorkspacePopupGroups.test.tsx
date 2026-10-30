import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceActionHost } from "../workspaceActionHost";
import { createWorkspaceActionProjection } from "../workspaceActionProjection";
import { createWorkspaceSemanticIndexSnapshot } from "../workspaceSemanticIndex";
import { defaultCodeStyleSchemeStore } from "../workspaceCodeStyleSchemes";
import type { WorkspaceActionsController } from "../useWorkspaceActionsController";
import { WorkspaceNavigationPopups, type WorkspaceNavigationPopupsProps } from "./WorkspaceNavigationPopups";
import { WorkspaceEditingPopups, type WorkspaceEditingPopupsProps } from "./WorkspaceEditingPopups";

afterEach(cleanup);

function actionOwner() {
  const host = new WorkspaceActionHost({ workspaceId: "popup-groups" });
  const contextKey = {};
  const executeAction = vi.fn(async () => ({ kind: "applied" as const }));
  const projection = createWorkspaceActionProjection(() => ({ host, contextKey }), executeAction, () => true);
  const evaluate = vi.spyOn(host, "getSnapshot");
  return { host, projection, evaluate, controller: { host, projection } as WorkspaceActionsController };
}

// Only UI owners read by the group are supplied. The real popup components,
// projection and ActionHost run here; editor/provider services stay unmounted.
function navigationProps(owner: ReturnType<typeof actionOwner>): WorkspaceNavigationPopupsProps {
  return {
    actionsController: owner.controller,
    keyboard: { tabSwitcherOpen: false, tabSwitcherIndex: 0 },
    searchEverywhereOpen: false, searchEverywhereMode: "files",
    navigation: { goToFileItems: [], goToFileLoading: false, goToFileTruncated: false },
    seSymbolsAvailable: false, semanticIndex: { snapshot: createWorkspaceSemanticIndexSnapshot() },
    fetchWorkspaceSymbols: vi.fn(),
    uiActions: { recentLocationsOpen: false, setSearchEverywhereOpen: vi.fn(), setQuickDocOpen: vi.fn() },
    openWorkspaceSymbol: vi.fn(), runSearchEverywhereCommand: vi.fn(),
    keymap: {}, toolWindowRouting: {},
    recentFilesOpen: false, recentEntries: [], recentAdvanceNonce: 0,
    toolWindowActions: {}, workspaceInstanceId: "popup-groups",
    workspaceLocationControllerRef: { current: null }, navigationHistoryFacade: {},
    openFiles: {}, openFile: vi.fn(), librarySources: {}, roots: [],
    structureOpen: false, activeFile: null, structureSymbols: [],
    structureLoading: false, structureUnavailable: null, structureSyntaxOnly: true, structure: {},
    quickDocOpen: false, quickDocContent: null, documentation: {},
    referenceSessions: { referenceHistory: { canGoBack: false, canGoForward: false } },
    locationPeek: null, treeInteractions: { treeContextMenu: null, editorContextMenu: null },
    visible: true, structuralSearch: { dialogOpen: false, templateVariables: [] },
    usages: { usagesScopeDialog: null }, usagesActions: {},
    setStatusMessage: vi.fn(), lspClientEvents: { messageRequest: null },
  } as unknown as WorkspaceNavigationPopupsProps;
}

function editingProps(owner: ReturnType<typeof actionOwner>): WorkspaceEditingPopupsProps {
  return {
    actionsController: owner.controller,
    uiActions: {
      clipboardHistoryOpen: false, clipboardHistoryEntries: [], setClipboardHistoryOpen: vi.fn(),
      generateCode: { open: false, phase: "idle", candidates: [], error: null },
      surroundWithDialogOpen: false,
    },
    editorCommands: { executeActiveEditorCommand: vi.fn(), handleReturnToEditor: vi.fn() },
    clipboard: { clipboardHandle: {} }, codeGeneration: {}, activeLanguageId: null,
    setStatusMessage: vi.fn(), keymapCheatSheetOpen: false, setKeymapCheatSheetOpen: vi.fn(),
    codeInsightNotice: null, setCodeInsightNotice: vi.fn(), statusBridge: {}, activeLspState: null,
    goToLineRequest: null, setGoToLineRequest: vi.fn(),
    keymap: { keymapMigrationNoticeOpen: false, keymapSettingsOpen: false },
    codeStyle: { codeStyleSettingsOpen: false, codeStyleSchemes: defaultCodeStyleSchemeStore() },
    activeFile: null,
  } as unknown as WorkspaceEditingPopupsProps;
}

describe("closed workspace popup groups", () => {
  it("does not evaluate actions or read navigation data during unrelated file updates", () => {
    const owner = actionOwner();
    const initial = navigationProps(owner);
    const view = render(<WorkspaceNavigationPopups {...initial} />);
    expect(owner.evaluate).not.toHaveBeenCalled();
    const readFiles = vi.fn(() => []);
    const navigation = { ...initial.navigation, get goToFileItems() { return readFiles(); } };
    view.rerender(<WorkspaceNavigationPopups {...initial} navigation={navigation} />);
    act(() => owner.projection.publish());
    expect(readFiles).not.toHaveBeenCalled();
    expect(owner.evaluate).not.toHaveBeenCalled();
  });

  it("keeps closed editing data and action evaluations off background publications", () => {
    const owner = actionOwner();
    const initial = editingProps(owner);
    const view = render(<WorkspaceEditingPopups {...initial} />);
    expect(owner.evaluate).not.toHaveBeenCalled();
    const readClipboard = vi.fn(() => []);
    const uiActions = { ...initial.uiActions, get clipboardHistoryEntries() { return readClipboard(); } };
    view.rerender(<WorkspaceEditingPopups {...initial} uiActions={uiActions} />);
    act(() => owner.projection.publish());
    expect(readClipboard).not.toHaveBeenCalled();
    expect(owner.evaluate).not.toHaveBeenCalled();
  });

  it("reopens search with current files, callbacks and mode after closed updates", async () => {
    const owner = actionOwner();
    const initial = navigationProps(owner);
    const view = render(<WorkspaceNavigationPopups {...initial} />);
    const item = { rootId: "root", rootName: "project", path: "current.txt" };
    const pick = vi.fn();
    const latest = { ...initial, navigation: { ...initial.navigation, goToFileItems: [item], openGoToFileItem: pick } };
    view.rerender(<WorkspaceNavigationPopups {...latest} />);
    view.rerender(<WorkspaceNavigationPopups {...latest} searchEverywhereOpen />);
    fireEvent.click(await screen.findByText("current.txt"));
    expect(pick).toHaveBeenCalledWith(item);
    view.rerender(<WorkspaceNavigationPopups {...latest} />);
    expect(screen.queryByTestId("code-workspace-search-everywhere")).toBeNull();
    view.rerender(<WorkspaceNavigationPopups {...latest} searchEverywhereMode="actions" searchEverywhereOpen />);
    expect(screen.getByLabelText("Search actions")).toBeInTheDocument();
  });

  it("closes documentation with focus return and accepts a later LSP message and context menu", async () => {
    const owner = actionOwner();
    const initial = navigationProps(owner);
    const viewOf = (props: WorkspaceNavigationPopupsProps) => <><button>Editor invoker</button><WorkspaceNavigationPopups {...props} /></>;
    const view = render(viewOf(initial));
    const invoker = screen.getByText("Editor invoker");
    invoker.focus();
    const content = { title: "Doc", body: "Current documentation", source: "test" };
    view.rerender(viewOf({ ...initial, quickDocOpen: true, quickDocContent: content }));
    screen.getByTestId("code-workspace-quick-doc").focus();
    view.rerender(viewOf(initial));
    await waitFor(() => expect(invoker).toHaveFocus());
    const resolveMessageRequest = vi.fn();
    const request = {
      requestId: "late", workspaceId: "popup-groups", serverLabel: "LSP", messageType: 3,
      message: "Server requests a choice", actions: [{ title: "Continue indexing" }],
    };
    view.rerender(viewOf({ ...initial, lspClientEvents: { ...initial.lspClientEvents, messageRequest: request, resolveMessageRequest } }));
    fireEvent.click(screen.getByText("Continue indexing"));
    expect(resolveMessageRequest).toHaveBeenCalledWith(0);
    view.rerender(viewOf(initial));
    const onContextAction = vi.fn();
    view.rerender(viewOf({ ...initial, treeInteractions: { ...initial.treeInteractions, treeContextMenu: <button onClick={onContextAction}>Tree action</button> } }));
    fireEvent.click(screen.getByText("Tree action"));
    expect(onContextAction).toHaveBeenCalledOnce();
    view.rerender(viewOf(initial));
    expect(screen.queryByText("Tree action")).toBeNull();
  });

  it("reads the latest action owner on reopen and follows live publications in StrictMode", async () => {
    const owner = actionOwner();
    const initial = editingProps(owner);
    const view = render(<StrictMode><WorkspaceEditingPopups {...initial} /></StrictMode>);
    const run = vi.fn(async () => ({ kind: "applied" as const }));
    const register = (title: string) => owner.host.registerActions([{
      id: "popup.action", title, category: "Edit", keybinding: "Ctrl+K", provenance: "local", run,
    }]);
    register("Current action");
    act(() => owner.projection.publish());
    expect(owner.evaluate).not.toHaveBeenCalled();
    view.rerender(<StrictMode><WorkspaceEditingPopups {...initial} keymapCheatSheetOpen /></StrictMode>);
    expect(screen.getByText("Current action")).toBeInTheDocument();
    act(() => { register("Replacement action"); owner.projection.publish(); });
    expect(screen.getByText("Replacement action")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("keymap-run-popup.action"));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    view.rerender(<StrictMode><WorkspaceEditingPopups {...initial} /></StrictMode>);
    const evaluations = owner.evaluate.mock.calls.length;
    act(() => { register("Closed update"); owner.projection.publish(); });
    expect(owner.evaluate).toHaveBeenCalledTimes(evaluations);
    view.rerender(<StrictMode><WorkspaceEditingPopups {...initial} keymapCheatSheetOpen /></StrictMode>);
    expect(screen.getByText("Closed update")).toBeInTheDocument();
    view.unmount();
    act(() => owner.projection.publish());
  });

  it("opens clipboard and go-to-line from closed state with the current command target", async () => {
    const owner = actionOwner();
    const initial = editingProps(owner);
    const viewOf = (props: WorkspaceEditingPopupsProps) => <><button>Editor invoker</button><WorkspaceEditingPopups {...props} /></>;
    const view = render(viewOf(initial));
    const executeActiveEditorCommand = vi.fn();
    const entry = {
      sessionId: "latest", sourceViewId: null, rectangular: false, sourceEol: "lf" as const,
      plainText: "latest copied text", segments: ["latest copied text"], createdAt: Date.now(),
    };
    view.rerender(viewOf({
      ...initial, editorCommands: { ...initial.editorCommands, executeActiveEditorCommand },
      uiActions: { ...initial.uiActions, clipboardHistoryOpen: true, clipboardHistoryEntries: [entry] },
    }));
    fireEvent.keyDown(screen.getByTestId("clipboard-history-popup"), { key: "Enter" });
    expect(executeActiveEditorCommand).toHaveBeenCalledWith("pasteFromHistory", { historyIndex: 0 });
    view.rerender(viewOf(initial));
    const invoker = screen.getByText("Editor invoker");
    invoker.focus();
    const apply = vi.fn();
    const cancel = vi.fn();
    view.rerender(viewOf({ ...initial, goToLineRequest: { current: { line: 2, column: 3 }, lineCount: 10, apply, cancel } }));
    const input = screen.getByTestId("code-workspace-goto-line-input");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "7:4" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(apply).toHaveBeenCalledWith({ line: 7, column: 4 });
    expect(cancel).not.toHaveBeenCalled();
    view.rerender(viewOf(initial));
    await waitFor(() => expect(invoker).toHaveFocus());
  });

  it("opens, closes and reopens Code Style settings while the editor stays mounted", () => {
    const owner = actionOwner();
    const initial = editingProps(owner);
    const view = render(<WorkspaceEditingPopups {...initial} />);
    const open = { ...initial, codeStyle: { ...initial.codeStyle, codeStyleSettingsOpen: true } };
    view.rerender(<WorkspaceEditingPopups {...open} />);
    expect(screen.getByTestId("workspace-code-style-dialog")).toBeInTheDocument();
    view.rerender(<WorkspaceEditingPopups {...initial} />);
    expect(screen.queryByTestId("workspace-code-style-dialog")).toBeNull();
    view.rerender(<WorkspaceEditingPopups {...open} />);
    expect(screen.getByTestId("code-style-scheme-row-default")).toBeInTheDocument();
  });
});
