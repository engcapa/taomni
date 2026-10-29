import { BookOpen, FolderTree, GitCommitHorizontal, ListTree } from "../icons";
import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useCodeWorkspaceStatusStore } from "../../../../stores/codeWorkspaceStatusStore";
import type { CodeWorkspaceFileRef } from "../../../../types";
import { isPathContainedInRoot } from "../navigationHistoryModel";
import { type ToolWindowRailItem } from "../panels/ToolWindowRail";
import type { ShellShortcutClaim } from "../shellShortcutRouter";
import { useLatestHandlers } from "../useLatestHandlers";
import { useWorkspaceActionsController } from "../useWorkspaceActionsController";
import { useWorkspaceActionContext } from "./useWorkspaceActionContext";
import { type WorkspaceCommandContext } from "../workspaceCommands";
import { useSemanticNavigation } from "./useSemanticNavigation";
import { useWorkspaceActionPorts } from "./useWorkspaceActionPorts";
import { useWorkspaceCommandCatalog } from "./useWorkspaceCommandCatalog";
import { useWorkspaceCommandFocus } from "./useWorkspaceCommandFocus";
import { useWorkspaceDocumentEditing } from "./useWorkspaceDocumentEditing";
import { useWorkspaceEditingFeatures } from "./useWorkspaceEditingFeatures";
import { useWorkspaceFileOpening } from "./useWorkspaceFileOpening";
import { useWorkspaceKeyboard } from "./useWorkspaceKeyboard";
import { useWorkspaceKeymap } from "./useWorkspaceKeymap";
import { useWorkspaceProjectRuntime } from "./useWorkspaceProjectRuntime";
import { useWorkspaceSemanticFeatures } from "./useWorkspaceSemanticFeatures";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { useWorkspaceSurfaceState } from "./useWorkspaceSurfaceState";


export interface UseWorkspaceCommandRoutingContext {
  session: ReturnType<typeof useWorkspaceSession>;
  project: ReturnType<typeof useWorkspaceProjectRuntime>;
  semantics: ReturnType<typeof useWorkspaceSemanticFeatures>;
  surfaceState: ReturnType<typeof useWorkspaceSurfaceState>;
  files: ReturnType<typeof useWorkspaceFileOpening>;
  editorFeatures: ReturnType<typeof useWorkspaceEditingFeatures>;
  editing: ReturnType<typeof useWorkspaceDocumentEditing>;
  ports: ReturnType<typeof useWorkspaceActionPorts>;
  semanticNavigation: ReturnType<typeof useSemanticNavigation>;
  onOpenGitManager: ((payload: import("../controller/model").CodeWorkspaceGitManagerPayload) => void) | undefined;
  visible: boolean;
  onCommandsChange: ((tabId: string, registration: import("../workspaceCommands").WorkspaceCommandRegistration | null) => void) | undefined;
  tabId: string;
}

export function useWorkspaceCommandRouting(context: UseWorkspaceCommandRoutingContext) {
  const { session, project, semantics, surfaceState, files, editorFeatures, editing, ports, onOpenGitManager, visible, onCommandsChange, tabId } = context;
  const commandCatalog = useWorkspaceCommandCatalog({
    editorCommands: session.editorCommands,
    uiActions: project.uiActions,
    codeGeneration: semantics.codeGeneration,
    closedTabsStack: surfaceState.closedTabsStack,
    workspaceUi: session.workspaceUi,
    setClosedTabsStack: surfaceState.setClosedTabsStack,
    openFile: files.openFile,
    bufferState: session.bufferState,
    setStatusMessage: session.setStatusMessage,
    get keymap() { return keymap; },
    codeStyle: project.codeStyle,
    javaCreation: semantics.javaCreation,
    styleActions: editorFeatures.styleActions,
    navigation: files.navigation,
    seSymbolsAvailable: semantics.searchNavigation.seSymbolsAvailable,
    documentLanguage: editing.documentLanguage,
    navigateDiagnostic: editorFeatures.navigateDiagnostic,
    editorSelectionRef: session.editorSelectionRef,
    peekDefinitionRef: ports.peekDefinitionRef,
    showCodeInsightNotice: surfaceState.showCodeInsightNotice,
    intelligence: project.intelligence,
    appearance: project.appearance,
    tabPolicyOwner: session.tabPolicyOwner,
    copyReferenceAtCursor: editorFeatures.copyReferenceAtCursor,
    clipboard: session.clipboard,
    openFindInFiles: files.openFindInFiles,
    structuralSearch: semantics.searchNavigation.structuralSearch,
    structure: editorFeatures.structure,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    editState: project.editState,
    languagePreferences: editorFeatures.languagePreferences,
    documentation: semantics.documentation,
    intentions: editorFeatures.intentions,
    goToTypeDefinitionRef: ports.goToTypeDefinitionRef,
    goToImplementationRef: ports.goToImplementationRef,
    renameSymbolRef: ports.renameSymbolRef,
    safeDeleteSymbolRef: ports.safeDeleteSymbolRef,
    runExtractMethodRef: ports.runExtractMethodRef,
    t: session.t,
    editorAi: editing.editorAi,
    preferences: session.preferences,
    toolWindowActions: editorFeatures.toolWindowActions,
    hierarchy: semantics.hierarchy,
    goToDeclarationRef: ports.goToDeclarationRef,
    get semanticNavigation() { return context.semanticNavigation; },
    usages: project.usages,
    bookmarkActions: editorFeatures.bookmarkActions,
    occurrences: editorFeatures.occurrences,
    telemetry: project.telemetry,
    comparisons: editorFeatures.comparisons,
    readerMode: editorFeatures.readerMode,
    activeGitRoot: semantics.activeGitRoot,
    workspaceInstanceId: session.workspaceInstanceId,
    toolWindowRouting: project.toolWindowRouting,
    terminalDockRef: ports.terminalDockRef,
    runActiveJavaFileRef: ports.runActiveJavaFileRef,
    projectTree: project.projectTree,
    buildActiveProjectRef: ports.buildActiveProjectRef,
    recompileActiveFileRef: ports.recompileActiveFileRef,
    toggleActiveBreakpointRef: ports.toggleActiveBreakpointRef,
    viewBreakpointsAtCaretRef: ports.viewBreakpointsAtCaretRef,
    toggleTemporaryBreakpointRef: ports.toggleTemporaryBreakpointRef,
    toggleActiveBreakpointEnabledRef: ports.toggleActiveBreakpointEnabledRef,
    debugRef: ports.debugRef,
    openEvaluateDialogRef: ports.openEvaluateDialogRef,
    showDebugExecutionPointRef: ports.showDebugExecutionPointRef,
    runPanelRef: ports.runPanelRef,
    refactorRecovery: semantics.refactorRecovery,
    get keyboard() { return keyboard; },
    saves: editing.saves,
    fileLifecycle: editing.fileLifecycle,
    treeInteractions: files.treeInteractions,
    fileActions: files.fileActions,
    gitSnapshotOwner: project.gitSnapshotOwner,
    onOpenGitManager,
    openGitManager: semantics.openGitManager,
    splits: editing.splits,
    treeOpening: files.treeOpening,
    findInDirectory: files.findInDirectory,
    setKeymapCheatSheetOpen: surfaceState.setKeymapCheatSheetOpen,
    coverage: editorFeatures.coverage,
    setDapGuideOpen: surfaceState.setDapGuideOpen,
  });
  const commandFocus = useWorkspaceCommandFocus({
    treePaneRef: session.treeFocus.treePaneRef,
    editorPaneRef: surfaceState.editorPaneRef,
  });

  const actionContext = useWorkspaceActionContext({
    workspaceInstanceId: session.workspaceInstanceId,
    activeKey: session.workspaceUi.activeKey,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    activeFilePath: editing.documentLanguage.activeFile?.path,
    modalOpen: surfaceState.keymapCheatSheetOpen,
    editorCommands: session.editorCommands,
  });

  const actionsController = useWorkspaceActionsController({
    workspaceId: session.workspaceInstanceId,
    commands: commandCatalog.workspaceCommands,
    resolveFocus: commandFocus.commandFocusForTarget,
    getDefaultFocus: () => session.editorCommands.activeEditorCommandOwner() ? "editor" : "workspace",
    ...actionContext,
    // §8.16.3 typed-result visibility: surfaced outcomes instead of silent no-ops.
    onCommandExecuted: (commandId, result) => {
      if (!result) return;
      if (result.kind === "failed") {
        session.setStatusMessage(`Action ${commandId} failed: ${result.message ?? "unknown error"}`);
      } else if (result.kind === "cancelled") {
        session.setStatusMessage(`Action ${commandId} cancelled`);
      } else if (result.kind === "no-op" && result.reason && result.reason !== "condition-not-met") {
        // §8.18.2 result sink: silent success stays quiet, but a blocked
        // no-op names its reason instead of disappearing.
        session.setStatusMessage(`Action ${commandId}: ${result.message ?? result.reason}`);
      }
    },
    // ED-PARITY-004 DEC-05: an ambiguous stroke used to be swallowed by all
    // three dispatchers. Name the contenders so the rejection is observable.
    onBindingConflict: (notice) => {
      session.setStatusMessage(
        `${notice.keybinding} is assigned to ${notice.actionIds.join(" and ")} — resolve it in Keymap Settings`,
      );
    },
  });

  const executeWorkspaceCommand = useCallback((
    commandId: string,
    context: WorkspaceCommandContext = { focus: "workspace" },
  ) => {
    return actionsController.executeCommand(commandId, context);
  }, [actionsController]);
  ports.workspaceCommandRunnerRef.current = executeWorkspaceCommand;

  const keymap = useWorkspaceKeymap({
    actionsController,
    rootRef: surfaceState.rootRef,
    visible,
  });
  const workspaceWidgetHost = useCodeWorkspaceStatusStore((s) => s.widgetHost);

  // Stable handler identities let the memoized project tree skip the
  // per-caret-move workspace re-render.
  const projectTreeHandlers = useLatestHandlers({
    onToggleRoot: files.fileActions.toggleRoot,
    onToggleDir: files.fileActions.toggleDir,
    onSelect: project.uiActions.setSelected,
    onOpenFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; }) => { void files.treeOpening.requestTreeOpen(ref, options); },
    onContextMenu: files.treeInteractions.showTreeContextMenu,
    onAddFolder: () => executeWorkspaceCommand("workspace.tree.addFolder", { focus: "tree" }),
    onOpenLooseFile: () => executeWorkspaceCommand("workspace.tree.openLooseFile", { focus: "tree" }),
  });

  // ED-PARITY-010 DEC-010-01: IDEA tool window stripes. The bottom-dock tools
  // render their own buttons into `bottomRailHost` (same testids as before).
  const railShortcut = (actionId: string) => actionsController.host.effectiveKeybindingDisplay(actionId)[0];
  const leftToolRailItems: ToolWindowRailItem[] = [
    {
      id: "project",
      label: "Project",
      icon: <FolderTree className="h-3.5 w-3.5" />,
      active: session.workspaceUi.languagePanelOpen,
      shortcut: railShortcut("workspace.toggleProjectTree"),
      onSelect: editorFeatures.toolWindowActions.toggleProjectTree,
    },
    {
      id: "commit",
      label: "Commit",
      icon: <GitCommitHorizontal className="h-3.5 w-3.5" />,
      active: session.workspaceUi.bottomDockOpen && session.workspaceUi.bottomDockTab === "git",
      shortcut: railShortcut("workspace.commitToolWindow"),
      disabled: project.gitSnapshotOwner.gitRoots.length === 0,
      disabledReason: "No Git repository in this workspace",
      onSelect: () => editorFeatures.toolWindowActions.handleActivateToolWindow("git"),
    },
  ];
  // ED-PARITY-011 DEC-011-05: tab names of files with error diagnostics.
  const filesWithErrors = useMemo(() => new Set(
    Object.entries(session.workspaceUi.lspFiles)
      .filter(([, state]) => state?.diagnostics?.some((diagnostic) => diagnostic.severity === 1))
      .map(([key]) => key),
  ), [session.workspaceUi.lspFiles]);
  // ED-PARITY-010 DEC-010-03: IDEA empty-editor tips with the live bindings.
  const emptyEditorHints = [
    { label: "Search Everywhere", shortcut: "Double Shift" },
    { label: "Go to File", shortcut: railShortcut("workspace.goToFile") },
    { label: "Recent Files", shortcut: railShortcut("workspace.recentFiles") },
    { label: "Navigation Bar", shortcut: railShortcut("workspace.activateNavigationBar") },
    { label: "Drop files here to open them" },
  ];
  const rightToolRailItems: ToolWindowRailItem[] = [
    {
      id: "structure",
      label: "Structure",
      icon: <ListTree className="h-3.5 w-3.5" />,
      active: project.toolWindowRouting.rightPaneOpen && session.workspaceUi.rightPaneTab === "outline",
      shortcut: railShortcut("workspace.toggleDocumentationPane"),
      onSelect: editorFeatures.toolWindowActions.toggleOutlinePane,
    },
    {
      id: "documentation",
      label: "Docs",
      icon: <BookOpen className="h-3.5 w-3.5" />,
      active: project.toolWindowRouting.rightPaneOpen && session.workspaceUi.rightPaneTab === "documentation",
      onSelect: () => {
        if (project.toolWindowRouting.rightPaneOpen && session.workspaceUi.rightPaneTab === "documentation") {
          project.toolWindowRouting.setRightPaneOpen(false);
          return;
        }
        project.toolWindowRouting.setRightPaneTab("documentation");
        project.toolWindowRouting.setRightPaneOpen(true);
      },
    },
  ];
  const keyboard = useWorkspaceKeyboard({
    activeKey: session.workspaceUi.activeKey,
    workspaceInstanceId: session.workspaceInstanceId,
    bottomDockOpen: session.workspaceUi.bottomDockOpen,
    bottomDockTab: session.workspaceUi.bottomDockTab,
    workspaceUi: session.workspaceUi,
    openFiles: session.workspaceUi.openFiles,
    editorGroups: session.workspaceUi.editorGroups,
    setStatusMessage: session.setStatusMessage,
    closeFile: editing.fileLifecycle.closeFile,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    openFilesRef: session.bufferState.openFilesRef,
    setStoreActiveEditorGroup: session.storeActions.setStoreActiveEditorGroup,
    setLeafActiveTab: session.storeActions.setLeafActiveTab,
    openFile: files.openFile,
    actionsController,
    visible,
    isSurfaceOwnedKeyEvent: commandFocus.isSurfaceOwnedKeyEvent,
    isNativeTextInputTarget: commandFocus.isNativeTextInputTarget,
    isEditorSurfaceKeyEvent: commandFocus.isEditorSurfaceKeyEvent,
    onCommandsChange,
    activeEditorCommandOwner: session.editorCommands.activeEditorCommandOwner,
    activeEditorGroupIdRef: surfaceState.activeEditorGroupIdRef,
  });

  const runSearchEverywhereCommand = useCallback((commandId: string) => {
    project.uiActions.setSearchEverywhereOpen(false);
    // §8.17.3: run the SAME frozen evaluation the list rendered — a stale or
    // disabled entry must not re-evaluate itself into a fresh context.
    const entry = actionsController.snapshot.find((item) => item.id === commandId);
    if (!entry) return;
    void actionsController.host.executePrepared(entry.evaluation);
  }, [actionsController]);

  const commandRegistration = actionsController.commandRegistration;

  // W0 §8.20.1: while this instance is the active workspace tab and its
  // reopen stack is non-empty, claim Ctrl+Shift+T from the shell router so
  // the chord reopens the closed tab instead of creating a local terminal.
  // Empty stack (or inactive tab) = no claim = shell owns the chord.
  const shellShortcutClaims = useMemo((): readonly ShellShortcutClaim[] => (
    visible && surfaceState.closedTabsStack.length > 0
      ? [{
        ownerId: session.workspaceInstanceId,
        actionId: "workspace.reopenClosedTab",
        scope: "active-workspace",
        priority: 40,
        enabled: true,
        canExecute: true,
        disabledReason: null,
      }]
      : []
  ), [visible, surfaceState.closedTabsStack.length, session.workspaceInstanceId]);
  const commandRegistrationWithClaims = useMemo(
    () => (
      shellShortcutClaims.length > 0
        ? { ...commandRegistration, shellShortcutClaims }
        : commandRegistration
    ),
    [commandRegistration, shellShortcutClaims],
  );

  useLayoutEffect(() => {
    if (!onCommandsChange) return;
    onCommandsChange(tabId, commandRegistrationWithClaims);
  }, [commandRegistrationWithClaims, onCommandsChange, tabId]);

  useEffect(() => {
    if (!onCommandsChange) return;
    return () => onCommandsChange(tabId, null);
  }, [onCommandsChange, tabId]);

  // Track navigation location on tab activation / file switch (I3)
  useEffect(() => {
    if (!visible || !editing.documentLanguage.activeFile || editing.documentLanguage.activeFileLoading) return;
    const file = session.bufferState.openFilesRef.current[editing.documentLanguage.activeFile.key] ?? editing.documentLanguage.activeFile;
    const text = file.text ?? "";
    const cursor = project.telemetry.cursorPositions[session.workspaceUi.activeEditorGroupId] ?? { line: 0, character: 0 };
    const lines = text.split("\n");
    const lineText = lines[cursor.line] ?? "";
    const startLine = Math.max(0, cursor.line - 1);
    const endLine = Math.min(lines.length, cursor.line + 2);
    const contextSnippet = lines.slice(startLine, endLine).join("\n");

    let sourceOwnership: "workspace" | "library" | "external" = "external";
    if (file.library) {
      sourceOwnership = "library";
    } else {
      const activeFilePath = file.path ?? file.title;
      const isInsideAnyRoot = project.projectTree.rootsRef.current.some((root) => isPathContainedInRoot(activeFilePath, root.path));
      if (isInsideAnyRoot) {
        sourceOwnership = "workspace";
      }
    }

    project.workspaceLocationControllerRef.current.recordNavigation({
      fileKey: file.key,
      filePath: file.path ?? file.title,
      title: file.title,
      line: cursor.line,
      character: cursor.character,
      lineText,
      contextSnippet,
      reason: "tab-switch",
      sourceOwnership,
    });
  }, [session.workspaceUi.activeEditorGroupId, editing.documentLanguage.activeFile?.key, editing.documentLanguage.activeFileLoading, visible]);
  return {
    keyboard,
    actionsController,
    emptyEditorHints,
    filesWithErrors,
    executeWorkspaceCommand,
    projectTreeHandlers,
    leftToolRailItems,
    rightToolRailItems,
    keymap,
    runSearchEverywhereCommand,
    workspaceWidgetHost,
  };
}
