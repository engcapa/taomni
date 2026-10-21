import { type WorkspaceGitRoot } from "../../../../lib/editor/workspace";
import { type LspPosition } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type BottomDockTabId, type EditorGroupId, type EditorSplitOrientation } from "../../../../stores/codeWorkspaceStore";
import { workspaceFileIdentity } from "../workspaceRecovery";
import { resolveReopenLocation, type ClosedTabEntry } from "../workspaceTabPolicy";
import { loadAutoImportPreferences } from "../../../../lib/autoImportPreferences";
import { type AutoImportCandidate, type AutoImportPlanOutcome } from "../autoImportModel";
import { planReformat } from "../reformatWorkflow";
import { type EditorAiAction } from "../editorAiPrompts";
import { answerLanguageLabelKey, type AiAnswerLanguage } from "../../../../lib/ai/answerLanguage";
import { type EditorCommandId, type EditorCommandState, type EditorSelectionRange } from "../CodeMirrorHost";
import { type EditorClipboardSession } from "../workspaceClipboardSession";
import { openSettingsSection } from "../../../../lib/settingsNavigation";
import { type WorkspaceIntelligencePreferences } from "../intelligencePreferences";
import { evaluateDestructiveRefactorAvailability, listRefactorRecoveryJournalsV2, isPendingRefactorRecoveryEntry, type RefactorRecoveryJournalEntryV2 } from "../refactorPlan";
import { languageServiceReadiness } from "../languageServiceReadiness";
import { type WorkspaceCoverageReport } from "../coverageModel";
import { findBookmarkByMnemonic, type WorkspaceBookmark } from "../todoBookmarks";
import { type OccurrenceHighlightSession } from "../occurrenceHighlightModel";
import { isDocCommentRenderingSupported } from "../renderedDocCommentsModel";
import { UsageQuerySession } from "../usageQuerySession";
import { type LocationPeekState } from "../LocationPeek";
import { type SearchEverywhereMode } from "../SearchEverywhere";
import { type WorkspaceCommand, type WorkspaceCommandContext } from "../workspaceCommands";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState, type TreeSelection, type WorkspaceTreeCommandPayload, errorMessage, normalizeFsPath } from "../codeWorkspaceModel";
import { type TerminalDockHandle } from "../panels/TerminalDockPanel";
import { type RunPanelHandle } from "../panels/RunPanel";
import { type CodeWorkspaceGitManagerPayload, isDeclarationDefinitionEquivalentLanguage, WORKSPACE_BOOKMARK_MNEMONICS } from "./model";



export interface WorkspaceCommandsContext {
  executeEditorCommand: (commandId: EditorCommandId, context?: WorkspaceCommandContext) => boolean;
  setSurroundWithDialogOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  requestGenerateCandidates: () => Promise<void>;
  closedTabsStack: readonly ClosedTabEntry[];
  workspaceUi: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi;
  activeEditorGroupId: string;
  setClosedTabsStack: import("react").Dispatch<import("react").SetStateAction<readonly ClosedTabEntry[]>>;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  setStatusMessage: (message: string) => void;
  setKeymapSettingsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setCodeStyleSettingsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setFileTemplateSettingsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setAutoImportSettingsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  executeAutoImportOnTheFly: (targetFile?: OpenFileState) => Promise<AutoImportPlanOutcome>;
  executePasteWithAutoImport: (textToPaste?: string, candidatesOverride?: readonly AutoImportCandidate[]) => Promise<boolean>;
  openSearchEverywhere: (mode?: SearchEverywhereMode) => void;
  seSymbolsAvailable: boolean;
  recentFilesOpen: boolean;
  openRecentFiles: (options?: { changedOnly?: boolean; }) => void;
  recentChangedOnly: boolean;
  setRecentLocationsChangedOnly: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setRecentLocationsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  navigateLastEditLocation: () => void;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  navigateDiagnostic: (direction: 1 | -1) => void;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  peekDefinitionRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<boolean>>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  showCodeInsightNotice: (message: string, action?: "configure" | null) => void;
  setParameterInfoRequestNonce: import("react").Dispatch<import("react").SetStateAction<number>>;
  setEditorAppearanceSettingsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  openTabPolicySettings: () => void;
  editorCommandStateFor: (context?: WorkspaceCommandContext) => EditorCommandState | null;
  copyReferenceAtCursor: () => Promise<void>;
  clipboardHandle: import("../workspaceClipboardSession").WorkspaceClipboardHandle;
  setClipboardHistoryEntries: import("react").Dispatch<import("react").SetStateAction<EditorClipboardSession[]>>;
  setClipboardHistoryOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setIntelligenceSettingsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  optimizeImports: () => Promise<void>;
  runRearrangeExecute: (file: OpenFileState) => Promise<boolean>;
  runCleanupExecute: (file: OpenFileState) => Promise<boolean>;
  navCan: { back: boolean; forward: boolean; };
  navigateHistory: (delta: -1 | 1) => void;
  openFindInFiles: (focusTarget?: "query" | "replace") => void;
  structuralSearch: { dialogOpen: boolean; draft: import("../useStructuralSearchSession").StructuralSearchDraft; setDraft: import("react").Dispatch<import("react").SetStateAction<import("../useStructuralSearchSession").StructuralSearchDraft>>; phase: import("../useStructuralSearchSession").StructuralSearchPhase; message: string | null; result: import("../useStructuralSearchSession").StructuralSearchResultState | null; capabilities: import("../../../../lib/editor/structuralSearch").StructuralSearchCapabilities | null; capabilitiesLoaded: boolean; availability: import("../companionCapabilities").StructuralSearchAvailability; templateVariables: string[]; open: () => void; cancel: () => void; find: () => Promise<void>; refreshCapabilities: () => Promise<import("../../../../lib/editor/structuralSearch").StructuralSearchCapabilities | null>; activeFileAvailable: boolean; };
  openStructurePopup: () => Promise<void>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  activeLanguageId: string | null;
  workspaceResourceOperationLocked: boolean;
  activeCapabilities: import("../../../../lib/editor/lsp").LspCapabilitySummary | null;
  formatActiveFile: () => Promise<boolean>;
  intelligencePreferences: WorkspaceIntelligencePreferences;
  setFormatOnSave: (enabled: boolean) => void;
  openQuickDocumentation: () => Promise<void>;
  runTypeInfo: () => Promise<void>;
  externalDocTargetFromProvider: () => { url: string; title: string; } | null;
  runExternalDocumentation: () => Promise<void>;
  runExpressionStaticData: () => Promise<void>;
  openCodeActionsAtCursor: (context?: WorkspaceCommandContext) => Promise<void>;
  resolveEditorTarget: (context?: WorkspaceCommandContext) => { file: OpenFileState | null; position: LspPosition | undefined; };
  goToTypeDefinitionRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<boolean>>;
  goToImplementationRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<boolean>>;
  renameSymbolRef: import("react").RefObject<() => Promise<void>>;
  safeDeleteSymbolRef: import("react").RefObject<() => Promise<void>>;
  openRefactorActions: (only: string[], sectionLabel: string) => Promise<void>;
  runExtractMethodRef: import("react").RefObject<() => Promise<void>>;
  t: import("../../../../lib/i18n").TranslateFn;
  runEditorAiActionAtCursor: (action: EditorAiAction) => Promise<void>;
  editorAiPreferences: import("../editorAiPreferences").EditorAiPreferences;
  cycleAiAnswerLanguage: () => void;
  setAiAnswerLanguage: (answerLanguage: AiAnswerLanguage) => void;
  languagePanelOpen: boolean;
  handleActivateToolWindow: (requestedId: string) => void;
  handleReturnToEditor: () => void;
  handleRestoreToolWindowLayout: () => void;
  jumpToLastToolWindow: () => void;
  hideActiveToolWindow: () => boolean;
  toggleAllToolWindows: () => void;
  openHierarchy: (mode: "call" | "type") => Promise<void>;
  goToDeclarationRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<boolean>>;
  goToDefinition: (file: OpenFileState, position: LspPosition) => Promise<boolean>;
  activeKey: string | null;
  findReferencesRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<void>>;
  usageSessionRef: import("react").RefObject<UsageQuerySession | null>;
  setLocationPeek: (peek: LocationPeekState | null) => void;
  toggleTodosPane: () => void;
  toggleBookmarkAtCursor: () => void;
  chooseMnemonicBookmarkAtCursor: () => Promise<void>;
  openTodosPane: () => void;
  bookmarks: WorkspaceBookmark[];
  jumpToMnemonicBookmark: (mnemonic: string) => void;
  activateNavigationBar: () => void;
  highlightUsagesInFile: () => Promise<void>;
  occurrenceSessionRef: import("react").RefObject<OccurrenceHighlightSession | null>;
  navigateOccurrence: (direction: "next" | "previous") => void;
  clearHighlightUsages: () => boolean;
  compareWithClipboard: () => Promise<void>;
  compareWithFile: () => Promise<void>;
  compareWithLocalHistory: () => Promise<void>;
  activeRenderedDocLanguageId: string | null;
  toggleRenderedDocComments: () => void;
  toggleInlayHints: () => void;
  activeInlayHintsEnabled: boolean;
  toggleInlayHintsForActiveLanguage: () => void;
  activeGitRoot: WorkspaceGitRoot | null;
  toggleInlineBlame: () => void;
  activeFileSoftWrap: boolean;
  toggleSoftWrap: () => void;
  columnSelectionMode: boolean;
  toggleColumnSelectionMode: () => void;
  workspaceInstanceId: string;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  terminalDockRef: import("react").RefObject<TerminalDockHandle | null>;
  runActiveJavaFileRef: import("react").RefObject<() => void>;
  roots: CodeWorkspaceRootInfo[];
  buildActiveProjectRef: import("react").RefObject<(rebuild?: boolean) => void>;
  recompileActiveFileRef: import("react").RefObject<() => void>;
  cursorPositionsRef: import("react").RefObject<Record<string, LspPosition>>;
  toggleActiveBreakpointRef: import("react").RefObject<(line: number) => void>;
  viewBreakpointsAtCaretRef: import("react").RefObject<(line: number) => void>;
  toggleTemporaryBreakpointRef: import("react").RefObject<(line: number) => void>;
  toggleActiveBreakpointEnabledRef: import("react").RefObject<(line: number) => void>;
  debugRef: import("react").RefObject<import("../useCodeDebugSession").CodeDebugSession | null>;
  openEvaluateDialogRef: import("react").RefObject<(expression?: string) => void>;
  showDebugExecutionPointRef: import("react").RefObject<() => void>;
  runPanelRef: import("react").RefObject<RunPanelHandle | null>;
  workspaceEditHistoryState: import("../workspaceEditHistory").WorkspaceEditHistoryState;
  searchEverywhereOpen: boolean;
  requestWorkspaceUndoConfirmation: () => void;
  redoWorkspaceEdit: () => Promise<void>;
  promptRefactorRecoveryEntry: (entry: RefactorRecoveryJournalEntryV2, ownerInstanceId: string) => Promise<void>;
  activeKeyRef: import("react").RefObject<string | null>;
  saveFile: (key?: string | null) => Promise<void>;
  closeFile: (key: string, groupId?: EditorGroupId, options?: { discard?: boolean; }) => Promise<void>;
  revealEditorTabInTree: (key: string) => void;
  reloadFile: (key?: string | null) => Promise<void>;
  refreshTree: () => void;
  gitRootsLoading: boolean;
  onOpenGitManager: ((payload: CodeWorkspaceGitManagerPayload) => void) | undefined;
  gitRoots: WorkspaceGitRoot[];
  openGitManager: () => void;
  splitOrientation: EditorSplitOrientation | null;
  setSyncSplitScroll: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  splitEditor: (orientation: EditorSplitOrientation, key?: string | null, sourceGroupId?: string) => void;
  goToAdjacentSplit: (direction: 1 | -1) => boolean;
  moveActiveTabToAdjacentSplit: (direction: 1 | -1) => boolean;
  equalizeActiveSplitRatios: () => boolean;
  stretchActiveSplit: () => boolean;
  unsplitAllWindows: () => boolean;
  openLooseFile: () => Promise<void>;
  addRoot: () => Promise<void>;
  treeContextMenuSessionRef: import("react").RefObject<{ workspaceInstanceId: string; selection: TreeSelection | null; consumed: boolean; } | null>;
  selected: TreeSelection | null;
  requestTreeOpen: (ref: CodeWorkspaceFileRef, options?: { targetGroupId?: EditorGroupId; split?: boolean; preview?: boolean; }) => Promise<void>;
  selectedRootDirectory: { rootId: string; path: string; } | null;
  createFile: (target?: { rootId: string; path: string; }) => Promise<void>;
  createDir: (target?: { rootId: string; path: string; }) => Promise<void>;
  openNewJavaClassDialog: (target?: { rootId: string; path: string; }) => void;
  renameSelected: (target?: TreeSelection) => Promise<void>;
  deleteSelected: (target?: TreeSelection) => Promise<void>;
  ignoreWorkspacePath: (rootId: string, path: string, directory: boolean) => Promise<void>;
  findInDirectory: (path: string) => void;
  copyTreePath: (rootId: string, path: string, absolute: boolean) => Promise<void>;
  setKeymapCheatSheetOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  coverageReport: WorkspaceCoverageReport | null;
  scanWorkspaceCoverage: () => Promise<void>;
  setDapGuideOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
}


export function createWorkspaceCommands(controllerContext: WorkspaceCommandsContext) {
  return (): import("../workspaceCommands").WorkspaceCommand[] => [
    {
      id: "editor.completeStatement",
      title: "Complete Statement",
      category: "Edit",
      keybinding: "Ctrl+Shift+Enter",
      keywords: ["semicolon", "finish", "statement"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile && !context.readOnly,
      run: (context) => controllerContext.executeEditorCommand("completeStatement", context),
    },
    {
      // §8.19.8: one Surround With entry opens the kind dialog; try/catch is
      // no longer a hard-wired command and every kind shares the same
      // plan builder, single transaction and undo entry.
      id: "editor.surroundWith",
      title: "Surround With…",
      category: "Edit",
      keybinding: "Ctrl+Alt+T",
      // IDEA XWin lists Ctrl+Alt+Shift+B first (Ctrl+Alt+T opens a terminal on many desktops).
      keybindings: ["Ctrl+Alt+Shift+B", "Meta+Alt+T"],
      keywords: ["surround", "wrap", "try", "catch", "if", "while", "runnable"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile && !context.readOnly,
      run: () => {
        controllerContext.setSurroundWithDialogOpen(true);
        return true;
      },
    },
    {
      // §8.19.8 Generate Code: the dialog lists exactly what the provider
      // returned; without a provider this stays honestly empty.
      id: "editor.generateCode",
      title: "Generate Code…",
      category: "Code",
      keybinding: "Alt+Insert",
      keybindings: ["Meta+n"],
      keywords: ["generate", "constructor", "getter", "setter", "toString", "override"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile && !context.readOnly,
      run: () => {
        void controllerContext.requestGenerateCandidates();
        return true;
      },
    },
    {
      // §8.18.8 Smart completion stays visible but typed-unavailable until a
      // provider advertises expected types; it never relabels Basic results.
      id: "editor.smartCompletion",
      title: "Type-Matching Completion (Smart)",
      category: "Edit",
      provenance: "unsupported",
      keywords: ["smart", "type matching", "completion"],
      when: () => false,
      run: () => false,
    },
    {
      id: "workspace.reopenClosedTab",
      title: "Reopen Closed Tab",
      category: "File",
      keybinding: "Ctrl+Shift+T",
      keywords: ["reopen", "closed", "tab", "undo close"],
      run: () => {
        // §8.18.5: pop the newest entry that still resolves to a real file.
        // §8.19.6: resolve against the LIVE tree — original leaf, then the
        // nearest surviving ancestor along the recorded route, then the leaf
        // owning the most former siblings, then the active editor.
        while (controllerContext.closedTabsStack.length > 0) {
          const [entry, ...rest] = controllerContext.closedTabsStack;
          const resolution = entry?.ref && entry.location
            ? resolveReopenLocation(controllerContext.workspaceUi.layoutTreeV2, entry.location, controllerContext.activeEditorGroupId)
            : null;
          controllerContext.setClosedTabsStack(rest);
          if (entry && entry.ref) {
            const openPromise = controllerContext.openFile(
              entry.ref as never,
              resolution ? { groupId: resolution.leafId } : undefined,
            );
            void openPromise.then(() => {
              const opened = Object.values(controllerContext.openFilesRef.current).some((candidate) => (
                workspaceFileIdentity(candidate.ref) === entry.fileIdentity
                && !candidate.loading
                && !candidate.error
              ));
              if (opened && resolution?.kind === "relocated") {
                controllerContext.setStatusMessage(
                  resolution.reason === "route"
                    ? `Reopened ${entry.title} in the nearest surviving split`
                    : resolution.reason === "sibling"
                      ? `Reopened ${entry.title} next to its former tab group`
                      : `Reopened ${entry.title} in the active editor`,
                );
              }
            }).catch((error) => controllerContext.setStatusMessage(errorMessage(error)));
            return true;
          }
        }
        controllerContext.setStatusMessage("No recently closed tab to reopen");
        return false;
      },
    },
    {
      id: "workspace.keymapSettings",
      title: "Keymap Settings",
      category: "Help",
      keywords: ["keymap", "shortcut", "scheme", "keybinding"],
      run: () => {
        controllerContext.setKeymapSettingsOpen(true);
        return true;
      },
    },
    {
      // §8.19.9 R8-D1: scheme management surface (copy/rename/delete/reset +
      // provenance); the active scheme feeds effective-style resolution.
      id: "workspace.codeStyleSettings",
      title: "Code Style Settings",
      category: "View",
      keywords: ["code style", "scheme", "indent", "spaces", "end of line"],
      run: () => {
        controllerContext.setCodeStyleSettingsOpen(true);
        return true;
      },
    },
    {
      id: "workspace.fileTemplateSettings",
      title: "File and Code Template Settings",
      category: "Preferences",
      keywords: ["file templates", "code templates", "java template", "class template"],
      run: () => {
        controllerContext.setFileTemplateSettingsOpen(true);
        return true;
      },
    },
    {
      id: "workspace.autoImportSettings",
      title: "Auto Import Settings",
      category: "Preferences",
      keywords: ["auto import", "imports", "on the fly", "paste import"],
      run: () => {
        controllerContext.setAutoImportSettingsOpen(true);
        return true;
      },
    },
    {
      id: "workspace.autoImportOnTheFly",
      title: "Auto Import on the Fly",
      category: "Code",
      keywords: ["auto import", "import symbol", "resolve imports"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile && !context.readOnly,
      run: () => {
        void controllerContext.executeAutoImportOnTheFly();
        return true;
      },
    },
    {
      id: "workspace.pasteWithAutoImport",
      title: "Paste with Auto Import",
      category: "Edit",
      keywords: ["paste", "auto import", "paste with imports"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile && !context.readOnly,
      run: () => {
        void controllerContext.executePasteWithAutoImport();
        return true;
      },
    },
    {
      id: "workspace.goToFile",
      title: "Go to File",
      category: "Navigation",
      keybinding: "Ctrl+Shift+N",
      keybindings: ["Meta+Shift+N"],
      keywords: ["search everywhere", "file", "open"],
      run: () => controllerContext.openSearchEverywhere("files"),
    },
    {
      id: "workspace.goToClass",
      title: "Go to Class",
      category: "Navigation",
      keybinding: "Ctrl+N",
      keywords: ["type", "interface", "struct"],
      run: () => controllerContext.openSearchEverywhere(controllerContext.seSymbolsAvailable ? "classes" : "files"),
    },
    {
      id: "workspace.goToSymbol",
      title: "Go to Symbol",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Shift+N",
      keywords: ["workspace symbol"],
      run: () => controllerContext.openSearchEverywhere(controllerContext.seSymbolsAvailable ? "symbols" : "files"),
    },
    {
      id: "workspace.searchEverywhere",
      title: "Search Everywhere",
      category: "Navigation",
      keywords: ["double shift", "all"],
      run: () => controllerContext.openSearchEverywhere("all"),
    },
    {
      id: "workspace.recentFiles",
      title: "Recent Files",
      category: "Navigation",
      keybinding: "Ctrl+E",
      keywords: ["previous", "history"],
      // ED-PARITY-014 DEC-014-03: IDEA toggles "Show edited only" on a
      // repeated Ctrl+E instead of stepping the selection.
      run: () => {
        if (controllerContext.recentFilesOpen) controllerContext.openRecentFiles({ changedOnly: !controllerContext.recentChangedOnly });
        else controllerContext.openRecentFiles();
      },
    },
    {
      id: "workspace.recentLocations",
      title: "Recent Locations",
      category: "Navigation",
      keybinding: "Ctrl+Shift+E",
      keywords: ["recent", "locations", "snippet", "preview", "history"],
      run: () => {
        controllerContext.setRecentLocationsChangedOnly(false);
        controllerContext.setRecentLocationsOpen(true);
      },
    },
    {
      id: "workspace.recentChangedFiles",
      title: "Recently Changed Files",
      category: "Navigation",
      keywords: ["modified", "changes", "history"],
      run: () => {
        controllerContext.setRecentLocationsChangedOnly(true);
        controllerContext.setRecentLocationsOpen(true);
      },
    },
    {
      id: "workspace.lastEditLocation",
      title: "Last Edit Location",
      category: "Navigation",
      keybinding: "Ctrl+Shift+Backspace",
      keywords: ["edit", "history", "previous", "back"],
      run: () => {
        controllerContext.navigateLastEditLocation();
      },
    },
    {
      id: "workspace.nextError",
      title: "Next Highlighted Error / Warning",
      category: "Navigation",
      keybinding: "F2",
      keywords: ["error", "warning", "diagnostic", "problem", "next"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile,
      run: () => controllerContext.navigateDiagnostic(1),
    },
    {
      id: "workspace.prevError",
      title: "Previous Highlighted Error / Warning",
      category: "Navigation",
      keybinding: "Shift+F2",
      keywords: ["error", "warning", "diagnostic", "problem", "previous"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile,
      run: () => controllerContext.navigateDiagnostic(-1),
    },
    {
      id: "workspace.quickDefinition",
      title: "Quick Definition",
      category: "Navigation",
      keybinding: "Ctrl+Shift+I",
      keybindings: ["Mod-Shift-I"],
      keywords: ["peek definition", "implementation", "quick"],
      when: () => !!controllerContext.activeFile,
      run: () => {
        const file = controllerContext.activeFile;
        if (!file) return;
        const pos = controllerContext.editorSelectionRef.current.end;
        void controllerContext.peekDefinitionRef.current(file, { line: pos.line, character: pos.character });
      },
    },
    {
      id: "workspace.parameterInfo",
      title: "Parameter Info",
      category: "Code",
      keybinding: "Ctrl+P",
      keybindings: ["Mod-P"],
      keywords: ["signature", "parameters", "arguments"],
      when: () => !!controllerContext.activeFile,
      run: () => {
        if (!controllerContext.activeFile) return;
        // DEC-020-01: an unavailable service answers with a caret popup.
        const readiness = languageServiceReadiness(controllerContext.lspFilesRef.current[controllerContext.activeFile.key] ?? null);
        if (readiness.kind !== "ready" && readiness.kind !== "idle") {
          controllerContext.showCodeInsightNotice(`Parameter info unavailable: ${readiness.message}`, readiness.action === "configure" ? "configure" : null);
          return;
        }
        controllerContext.setParameterInfoRequestNonce((nonce) => nonce + 1);
      },
    },
    {
      id: "workspace.editorAppearanceSettings",
      title: "Editor Appearance Settings",
      category: "View",
      keywords: ["font", "theme", "contrast", "wrap", "breadcrumbs", "virtual space", "zoom"],
      run: () => controllerContext.setEditorAppearanceSettingsOpen(true),
    },
    {
      id: "workspace.editorTabPolicySettings",
      title: "Editor Tab Policy Settings",
      category: "View",
      keywords: ["tab", "policy", "limit", "pinned", "preview", "order", "activate"],
      run: () => controllerContext.openTabPolicySettings(),
    },
    {
      id: "workspace.editor.copy",
      title: "Copy",
      category: "Edit",
      keybinding: "Ctrl+C",
      keybindings: ["Meta+C"],
      keywords: ["clipboard", "selection", "multi-caret"],
      when: (context) => context.focus === "editor"
        && controllerContext.editorCommandStateFor(context)?.hasSelection === true,
      run: (context) => { controllerContext.executeEditorCommand("copy", context); },
    },
    {
      id: "workspace.editor.cut",
      title: "Cut",
      category: "Edit",
      keybinding: "Ctrl+X",
      keybindings: ["Meta+X"],
      keywords: ["clipboard", "selection", "multi-caret"],
      when: (context) => {
        const state = controllerContext.editorCommandStateFor(context);
        return context.focus === "editor" && !!state
          && state.hasSelection && !state.readOnly && !state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("cut", context); },
    },
    {
      id: "workspace.editor.paste",
      title: "Paste",
      category: "Edit",
      keybinding: "Ctrl+V",
      keybindings: ["Meta+V"],
      keywords: ["clipboard", "multi-caret", "distribute"],
      when: (context) => {
        const state = controllerContext.editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => {
        const file = controllerContext.activeFile;
        if (file && (file.languagePath.endsWith(".java") || controllerContext.lspFilesRef.current[file.key]?.status?.languageId === "java")) {
          const settings = loadAutoImportPreferences();
          if (settings.pasteImportMode !== "none") {
            void controllerContext.executePasteWithAutoImport();
            return;
          }
        }
        controllerContext.executeEditorCommand("paste", context);
      },
    },
    {
      // §8.19.5 Plain Paste: rectangular/segment metadata is dropped; the
      // plain text replaces the selection like any ordinary paste.
      id: "workspace.editor.pasteAsPlainText",
      title: "Paste as Plain Text",
      category: "Edit",
      keybinding: "Ctrl+Shift+Alt+V",
      keybindings: ["Meta+Shift+Alt+V"],
      keywords: ["clipboard", "plain text", "paste without formatting"],
      when: (context) => {
        const state = controllerContext.editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("pasteAsPlainText", context); },
    },
    {
      // §8.19.5 Copy Reference: workspace-relative path:line, with a symbol
      // candidate only when the provider actually names one.
      id: "workspace.editor.copyReference",
      title: "Copy Reference",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+C",
      keybindings: ["Meta+Alt+Shift+C"],
      keywords: ["copy reference", "path line", "qualified name", "symbol"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile,
      run: () => { void controllerContext.copyReferenceAtCursor(); },
    },
    {
      // §8.19.5 Paste from History: session-only ring, searchable popup;
      // Enter dispatches the full segment plan at the caret as one undo.
      id: "editor.pasteFromHistory",
      title: "Paste from History…",
      category: "Edit",
      keybinding: "Ctrl+Shift+V",
      keybindings: ["Meta+Shift+V"],
      keywords: ["clipboard history", "paste history", "recent copies"],
      when: (context) => context.focus === "editor" && !!context.hasActiveFile
        && !context.readOnly,
      run: () => {
        const store = controllerContext.clipboardHandle;
        if (!store.isHistoryEnabled() || store.historyEntries().length === 0) {
          controllerContext.setStatusMessage("Clipboard history is empty or disabled");
          return true;
        }
        controllerContext.setClipboardHistoryEntries([...store.historyEntries()]);
        controllerContext.setClipboardHistoryOpen(true);
        return true;
      },
    },
    {
      id: "workspace.editor.moveStatementUp",
      title: "Move Statement Up",
      category: "Edit",
      keybinding: "Ctrl+Shift+ArrowUp",
      keybindings: ["Meta+Shift+ArrowUp"],
      keywords: ["statement", "line", "syntax", "move"],
      when: (context) => {
        const state = controllerContext.editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("moveStatementUp", context); },
    },
    {
      id: "workspace.editor.moveStatementDown",
      title: "Move Statement Down",
      category: "Edit",
      keybinding: "Ctrl+Shift+ArrowDown",
      keybindings: ["Meta+Shift+ArrowDown"],
      keywords: ["statement", "line", "syntax", "move"],
      when: (context) => {
        const state = controllerContext.editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("moveStatementDown", context); },
    },
    {
      id: "workspace.editor.cloneCaretAbove",
      title: "Clone Caret Above",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+ArrowUp",
      keywords: ["caret", "cursor", "multi-caret", "above"],
      when: (context) => {
        const state = controllerContext.editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("cloneCaretAbove", context); },
    },
    {
      id: "workspace.editor.cloneCaretBelow",
      title: "Clone Caret Below",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+ArrowDown",
      keywords: ["caret", "cursor", "multi-caret", "below"],
      when: (context) => {
        const state = controllerContext.editorCommandStateFor(context);
        return context.focus === "editor" && !!state && !state.readOnly && !state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("cloneCaretBelow", context); },
    },
    {
      id: "workspace.editor.collapseCarets",
      title: "Collapse Carets",
      category: "Edit",
      keybinding: "Escape",
      keywords: ["caret", "selection", "occurrence", "escape"],
      when: (context) => {
        const state = controllerContext.editorCommandStateFor(context);
        return context.focus === "editor" && !!state
          && (state.caretCount > 1 || state.occurrenceSessionActive);
      },
      run: (context) => { controllerContext.executeEditorCommand("collapseCarets", context); },
    },
    {
      id: "workspace.editor.selectNextOccurrence",
      title: "Select Next Occurrence",
      category: "Edit",
      keybinding: "Alt+J",
      keywords: ["occurrence", "caret", "selection", "next"],
      when: (context) => context.focus === "editor"
        && !!controllerContext.editorCommandStateFor(context),
      run: (context) => { controllerContext.executeEditorCommand("selectNextOccurrence", context); },
    },
    {
      id: "workspace.editor.selectAllOccurrences",
      title: "Select All Occurrences",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+J",
      keybindings: ["Meta+Alt+Shift+J"],
      keywords: ["occurrence", "caret", "selection", "all"],
      when: (context) => context.focus === "editor"
        && !!controllerContext.editorCommandStateFor(context),
      run: (context) => { controllerContext.executeEditorCommand("selectAllOccurrences", context); },
    },
    {
      id: "workspace.editor.foldSelection",
      title: "Fold Selection",
      category: "Edit",
      keybinding: "Ctrl+Period",
      keybindings: ["Meta+Period"],
      keywords: ["fold", "selection", "collapse"],
      when: (context) => context.focus === "editor"
        && controllerContext.editorCommandStateFor(context)?.hasSelection === true,
      run: (context) => { controllerContext.executeEditorCommand("foldSelection", context); },
    },
    {
      id: "workspace.editor.foldAll",
      title: "Fold All",
      category: "Edit",
      keybinding: "Ctrl+Shift+NumpadSubtract",
      keybindings: ["Ctrl+Shift+Minus"],
      keywords: ["fold", "collapse", "all"],
      when: (context) => context.focus === "editor"
        && !!controllerContext.editorCommandStateFor(context),
      run: (context) => { controllerContext.executeEditorCommand("foldAll", context); },
    },
    {
      id: "workspace.editor.unfoldAll",
      title: "Unfold All",
      category: "Edit",
      keybinding: "Ctrl+Shift+NumpadAdd",
      keybindings: ["Ctrl+Shift+Equal"],
      keywords: ["fold", "expand", "all"],
      when: (context) => context.focus === "editor"
        && !!controllerContext.editorCommandStateFor(context),
      run: (context) => { controllerContext.executeEditorCommand("unfoldAll", context); },
    },
    {
      id: "workspace.intelligenceSettings",
      title: "Editor Intelligence Settings",
      category: "Code",
      keywords: ["hover", "documentation", "parameter info", "signature", "delay"],
      run: () => controllerContext.setIntelligenceSettingsOpen(true),
    },
    {
      id: "workspace.optimizeImports",
      title: "Optimize Imports",
      category: "Code",
      keybinding: "Ctrl+Alt+O",
      keybindings: ["Mod-Alt-O"],
      keywords: ["organize imports", "clean imports", "sort imports"],
      when: () => !!controllerContext.activeFile,
      run: () => void controllerContext.optimizeImports(),
    },
    {
      id: "workspace.rearrangeCode",
      title: "Rearrange Code",
      category: "Code",
      keywords: ["rearrange", "members", "order", "declarations", "structure"],
      when: () => !!controllerContext.activeFile,
      run: () => {
        if (!controllerContext.activeFile) return false;
        return controllerContext.runRearrangeExecute(controllerContext.activeFile);
      },
    },
    {
      id: "workspace.codeCleanup",
      title: "Code Cleanup...",
      category: "Code",
      keywords: ["cleanup", "inspect", "batch", "optimize", "profile"],
      when: () => !!controllerContext.activeFile,
      run: () => {
        if (!controllerContext.activeFile) return;
        return controllerContext.runCleanupExecute(controllerContext.activeFile);
      },
    },
    {
      id: "workspace.navigateBack",
      title: "Navigate Back",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Left",
      // Also accept Alt+Left (common IDEA keymap variant) when history is available.
      keybindings: ["Alt+Left"],
      when: () => controllerContext.navCan.back,
      run: () => controllerContext.navigateHistory(-1),
    },
    {
      id: "workspace.navigateForward",
      title: "Navigate Forward",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Right",
      keybindings: ["Alt+Right"],
      when: () => controllerContext.navCan.forward,
      run: () => controllerContext.navigateHistory(1),
    },
    {
      id: "workspace.findInFiles",
      title: "Find in Files",
      category: "Search",
      keybinding: "Ctrl+Shift+F",
      // macOS uses Command for the workspace-wide search chord.
      keybindings: ["Meta+Shift+F"],
      keywords: ["text", "content", "grep"],
      run: () => controllerContext.openFindInFiles(),
    },
    {
      id: "workspace.replaceInFiles",
      title: "Replace in Files",
      category: "Search",
      keybinding: "Ctrl+Shift+R",
      keybindings: ["Meta+Shift+R"],
      keywords: ["bulk replace"],
      run: () => {
        controllerContext.openFindInFiles("replace");
      },
    },
    {
      id: "workspace.searchStructurally",
      title: "Search Structurally…",
      category: "Search",
      keywords: ["structural", "ssr", "template", "ast"],
      run: () => controllerContext.structuralSearch.open(),
    },
    {
      id: "workspace.fileStructure",
      title: "File Structure",
      category: "Navigation",
      keybinding: "Ctrl+F12",
      keywords: ["outline", "symbol"],
      when: () => !!controllerContext.activeFile,
      run: () => void controllerContext.openStructurePopup(),
    },
    {
      id: "workspace.format",
      title: "Format Document",
      category: "Code",
      keybinding: "Ctrl+Alt+L",
      keywords: ["format", "prettier", "indent", "reformat"],
      when: (context) => {
        if (context.focus === "tree" || context.focus === "terminal") return false;
        // Capability readiness must not disable the command: an unreported
        // provider executes and reports its typed unavailable reason instead
        // (AC-FMT-03), and context menu + shortcut share this one action.
        return !!controllerContext.activeFile && !controllerContext.activeFile.loading;
      },
      run: () => {
        // §8.19.9 R8-D2 / ED-STYLE-001: one typed planner resolves the
        // executable scope; everything else surfaces a typed reason.
        const selection = controllerContext.editorSelectionRef.current;
        const hasSelection = !!selection && !selection.empty;
        const absPath = controllerContext.activeFile
          ? (controllerContext.absolutePathForOpenFile(controllerContext.activeFile) ?? controllerContext.activeFile.languagePath)
          : null;
        const languageKey = controllerContext.activeFile?.languagePath.split(".").pop()?.toLowerCase() ?? "";
        const decision = planReformat({
          scope: hasSelection ? "selection" : "file",
          targetPath: absPath,
          languageId: controllerContext.activeLanguageId ?? (languageKey || null),
          readOnly: !!controllerContext.activeFile?.library || controllerContext.workspaceResourceOperationLocked,
          hasSelection,
          capabilities: {
            formatting: !!controllerContext.activeCapabilities?.formatting,
            rangeFormatting: !!controllerContext.activeCapabilities?.rangeFormatting,
          },
        });
        if (controllerContext.activeCapabilities && decision.kind === "unavailable") {
          controllerContext.setStatusMessage(decision.reason);
          return false;
        }
        void controllerContext.formatActiveFile();
        return true;
      },
    },
    {
      id: "workspace.toggleFormatOnSave",
      title: `${controllerContext.intelligencePreferences.formatOnSave ? "Disable" : "Enable"} Format on Save`,
      category: "Code",
      keywords: ["format", "save", "workspace"],
      run: () => controllerContext.setFormatOnSave(!controllerContext.intelligencePreferences.formatOnSave),
    },
    {
      id: "workspace.quickDocumentation",
      title: "Quick Documentation",
      category: "Code",
      keybinding: "Ctrl+Q",
      // ED-PARITY-013: F1 is Quick Doc only in IDEA's macOS keymap; on
      // Windows/Linux IDEA reserves it for Context Help.
      platformKeybindings: { mac: ["Ctrl+Q", "F1"] },
      keywords: ["docs", "hover", "javadoc"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: () => void controllerContext.openQuickDocumentation(),
    },
    {
      // §8.20.2 W1: IDEA 2026.2 Type Info (Ctrl+Shift+P). Honest unavailable
      // contract until a provider exposes a typed channel.
      id: "workspace.typeInfo",
      title: "Type Info",
      category: "Code",
      keybinding: "Ctrl+Shift+P",
      keybindings: ["Mod-Shift-P"],
      keywords: ["expression type", "reference information"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: () => void controllerContext.runTypeInfo(),
    },
    {
      // §8.20.2 W1: enabled ONLY from a real provider URL in the last ready
      // quick documentation — never synthesized from the symbol name.
      id: "workspace.externalDocumentation",
      title: "External Documentation",
      category: "Code",
      keywords: ["javadoc online", "browser docs", "url"],
      when: (context) => context.focus !== "tree"
        && context.focus !== "terminal"
        && !!controllerContext.activeFile
        && !controllerContext.activeFile.loading
        && controllerContext.externalDocTargetFromProvider() !== null,
      run: () => void controllerContext.runExternalDocumentation(),
    },
    {
      // §8.20.2 W1: discoverable Expression Static Data entry; reports an
      // explicit provider-unavailable instead of local text guessing.
      id: "workspace.expressionStaticData",
      title: "Expression Static Data",
      category: "Code",
      keywords: ["static data", "branch", "nullness", "constant", "reference information"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: () => void controllerContext.runExpressionStaticData(),
    },
    {
      id: "workspace.codeActions",
      title: "Show Code Actions / Quick Fix",
      category: "Code",
      keybinding: "Alt+Enter",
      keywords: ["quickfix", "bulb", "intention"],
      when: (context) => context.focus !== "tree" && context.focus !== "terminal" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: (context) => controllerContext.openCodeActionsAtCursor(context),
    },
    {
      id: "workspace.gotoTypeDefinition",
      title: "Go to Type Definition",
      category: "Navigation",
      keybinding: "Ctrl+Shift+B",
      when: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        const capabilities = target.file
          ? controllerContext.lspFilesRef.current[target.file.key]?.status?.capabilities
          : null;
        return context.focus !== "tree" && !!target.file && !target.file.loading
          && (!capabilities || !!capabilities.typeDefinition);
      },
      run: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        if (!target.file || target.position === undefined) return;
        void controllerContext.goToTypeDefinitionRef.current(target.file, target.position);
      },
    },
    {
      id: "workspace.gotoImplementation",
      title: "Go to Implementation",
      category: "Navigation",
      keybinding: "Ctrl+Alt+B",
      when: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        const capabilities = target.file
          ? controllerContext.lspFilesRef.current[target.file.key]?.status?.capabilities
          : null;
        return context.focus !== "tree" && !!target.file && !target.file.loading
          && (!capabilities || !!capabilities.implementation);
      },
      run: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        if (!target.file || target.position === undefined) return;
        void controllerContext.goToImplementationRef.current(target.file, target.position);
      },
    },
    {
      id: "workspace.renameSymbol",
      title: "Rename Symbol",
      category: "Refactor",
      keybinding: "Shift+F6",
      keywords: ["refactor", "rename"],
      when: (context) => context.focus === "editor" && !!controllerContext.activeFile && !controllerContext.activeFile.loading
        && (!controllerContext.activeCapabilities || !!controllerContext.activeCapabilities.rename),
      run: () => void controllerContext.renameSymbolRef.current(),
    },
    {
      id: "workspace.safeDeleteSymbol",
      title: "Safe Delete Symbol",
      category: "Refactor",
      keybinding: "Alt+Delete",
      keybindings: ["Alt-Delete", "Alt-delete", "Alt+Delete"],
      keywords: ["refactor", "delete", "safe delete", "usages"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading
        && !controllerContext.activeFile.library,
      getState: () => {
        const availability = evaluateDestructiveRefactorAvailability(null);
        if (availability.state === "disabled") {
          return {
            availability: "disabled",
            disabledReason: availability.message,
            source: "provider",
            scope: "workspace",
            freshness: "current",
            completeness: "complete",
          };
        }
        return {
          availability: "available",
          source: "provider",
          scope: "workspace",
          freshness: "current",
          completeness: "complete",
        };
      },
      run: () => void controllerContext.safeDeleteSymbolRef.current(),
    },
    {
      id: "workspace.refactorThis",
      title: "Refactor This…",
      category: "Refactor",
      keybinding: "Ctrl+Alt+Shift+T",
      keybindings: ["Meta+Alt+Shift+T", "Meta+Alt+Shift+t", "Ctrl+T"],
      keywords: ["refactor", "refactor this", "extract", "inline", "rename", "move"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading
        && !controllerContext.activeFile.library && !!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor"], "Refactor actions"),
    },
    {
      id: "workspace.extractMethod",
      title: "Extract Method",
      category: "Refactor",
      keybinding: "Ctrl+Alt+M",
      // Keep the native Ctrl chord while giving macOS an explicit, parser-
      // compatible Command alias. The action host uses '+'-delimited bindings.
      keybindings: ["Meta+Alt+M", "Meta+Alt+m"],
      keywords: ["refactor", "extract", "method", "function"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading
        && !controllerContext.activeFile.library,
      run: () => void controllerContext.runExtractMethodRef.current(),
    },
    {
      id: "workspace.extractVariable",
      title: "Extract Variable",
      category: "Refactor",
      keybinding: "Ctrl+Alt+V",
      keybindings: ["Mod-Alt-V", "Mod-Alt-v"],
      keywords: ["refactor", "extract", "variable", "local"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading
        && !controllerContext.activeFile.library && !!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor.extract.variable", "refactor.extract.constant"], "Extract Variable/Constant actions"),
    },
    {
      id: "workspace.inline",
      title: "Inline",
      category: "Refactor",
      keybinding: "Ctrl+Alt+N",
      keybindings: ["Mod-Alt-N", "Mod-Alt-n"],
      keywords: ["refactor", "inline", "variable", "method", "function"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading
        && !controllerContext.activeFile.library && !!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor.inline"], "Inline actions"),
    },
    {
      id: "workspace.changeSignature",
      title: "Change Signature",
      category: "Refactor",
      keybinding: "Ctrl+F6",
      keybindings: ["Mod-F6"],
      keywords: ["refactor", "signature", "parameters", "arguments"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading
        && !controllerContext.activeFile.library && !!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor.rewrite.changeSignature", "refactor.changeSignature"], "Change Signature actions"),
    },
    {
      id: "workspace.moveRefactor",
      title: "Move",
      category: "Refactor",
      keybinding: "F6",
      keywords: ["refactor", "move", "symbol", "class"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading
        && !controllerContext.activeFile.library && !!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor.move", "refactor.rewrite"], "Move actions"),
    },
    {
      id: "workspace.aiExplainSyntax",
      title: controllerContext.t("codeWorkspaceAi.commandExplainSyntax"),
      category: "AI",
      // ED-PARITY-013 DEC-013-05: Ctrl+Alt+S is IDEA Settings; the Taomni
      // Classic keymap scheme keeps the old binding.
      keywords: ["ai", "syntax", "grammar", "teach", "learn", "explain", "语法", "讲解"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: () => void controllerContext.runEditorAiActionAtCursor("syntax"),
    },
    {
      id: "workspace.aiExplainCode",
      title: controllerContext.t("codeWorkspaceAi.commandExplainCode"),
      category: "AI",
      keybinding: "Ctrl+Alt+E",
      keywords: ["ai", "explain", "describe", "解释"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: () => void controllerContext.runEditorAiActionAtCursor("explain"),
    },
    {
      id: "workspace.aiFixSelection",
      title: controllerContext.t("codeWorkspaceAi.commandFix"),
      category: "AI",
      keywords: ["ai", "fix", "repair", "修复"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: () => void controllerContext.runEditorAiActionAtCursor("fix"),
    },
    {
      id: "workspace.aiAskSelection",
      title: controllerContext.t("codeWorkspaceAi.commandAsk"),
      category: "AI",
      keywords: ["ai", "ask", "rewrite", "改写", "询问"],
      when: (context) => context.focus !== "tree" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: () => void controllerContext.runEditorAiActionAtCursor("rewrite"),
    },
    {
      // The keyboard path to the explain actions bypasses the selection
      // toolbar, so without this there is no way to change the answer language
      // without reaching for the mouse.
      id: "workspace.aiCycleAnswerLanguage",
      title: controllerContext.t("codeWorkspaceAi.commandCycleAnswerLanguage", {
        current: controllerContext.t(answerLanguageLabelKey(controllerContext.editorAiPreferences.answerLanguage)),
      }),
      category: "AI",
      keywords: ["ai", "language", "answer", "chinese", "english", "语言", "回答", "中文", "英文"],
      run: controllerContext.cycleAiAnswerLanguage,
    },
    {
      id: "workspace.aiSetAnswerLanguage",
      title: "Set AI Answer Language",
      category: "AI",
      keywords: ["ai", "language", "answer", "语言"],
      run: (context) => {
        const payload = context.payload as { language?: string } | undefined;
        if (!payload || typeof payload.language !== "string") return;
        controllerContext.setAiAnswerLanguage(payload.language as AiAnswerLanguage);
      },
    },
    {
      id: "workspace.toggleProjectTree",
      title: controllerContext.languagePanelOpen ? "Hide Project Tree" : "Show Project Tree",
      category: "View",
      keybinding: "Alt+1",
      // IDEA macOS keymap: Cmd+1 activates Project (Option+1 kept as alias).
      platformKeybindings: { mac: ["Meta+1", "Alt+1"] },
      keywords: ["project", "explorer", "files", "tree", "sidebar", "collapse"],
      run: () => controllerContext.handleActivateToolWindow("project"),
    },
    {
      id: "workspace.activateToolWindow",
      title: "Activate Tool Window",
      category: "View",
      keywords: ["tool", "window", "panel", "dock", "activate"],
      run: (context) => {
        const payload = context.payload as { toolId?: string } | undefined;
        const toolId = payload?.toolId ?? "project";
        controllerContext.handleActivateToolWindow(toolId);
      },
    },
    {
      id: "workspace.returnToEditor",
      title: "Focus Editor",
      category: "View",
      keybinding: "Escape",
      keywords: ["focus", "editor", "escape", "return"],
      when: (context) => context.focus !== "editor" && context.focus !== "modal" && context.focus !== "search" && context.focus !== "completion" && context.focus !== "snippet",
      run: controllerContext.handleReturnToEditor,
    },
    {
      id: "workspace.restoreToolWindowLayout",
      title: "Restore Default Layout",
      category: "View",
      keybinding: "Shift+F12",
      keywords: ["layout", "restore", "default", "tool", "window", "reset"],
      run: controllerContext.handleRestoreToolWindowLayout,
    },
    {
      id: "workspace.jumpToLastToolWindow",
      title: "Jump to Last Tool Window",
      category: "View",
      keybinding: "F12",
      keywords: ["tool window", "last", "focus", "f12"],
      when: (context) => context.focus !== "modal",
      run: controllerContext.jumpToLastToolWindow,
    },
    {
      id: "workspace.hideActiveToolWindow",
      title: "Hide Active Tool Window",
      category: "View",
      keybinding: "Shift+Escape",
      keywords: ["tool window", "hide", "close", "escape"],
      when: (context) => context.focus !== "modal" && context.focus !== "completion" && context.focus !== "snippet",
      run: () => controllerContext.hideActiveToolWindow(),
    },
    {
      id: "workspace.hideAllToolWindows",
      title: "Hide All Tool Windows",
      category: "View",
      keybinding: "Ctrl+Shift+F12",
      keywords: ["tool windows", "hide", "maximize editor", "restore"],
      when: (context) => context.focus !== "modal",
      run: controllerContext.toggleAllToolWindows,
    },
    {
      id: "workspace.findAction",
      title: "Find Action…",
      category: "Help",
      keybinding: "Ctrl+Shift+A",
      platformKeybindings: { mac: ["Meta+Shift+A", "Ctrl+Shift+A"] },
      keywords: ["actions", "command", "palette", "find action", "assign shortcut"],
      // The terminal owns its keys; a modal owns its own keyboard state.
      when: (context) => context.focus !== "terminal" && context.focus !== "modal",
      run: () => controllerContext.openSearchEverywhere("actions"),
    },
    {
      id: "workspace.showSettings",
      title: "Settings…",
      category: "File",
      keybinding: "Ctrl+Alt+S",
      platformKeybindings: { mac: ["Meta+,", "Ctrl+Alt+S"] },
      keywords: ["settings", "preferences", "options"],
      when: (context) => context.focus !== "terminal" && context.focus !== "modal",
      run: () => openSettingsSection("general"),
    },
    {
      id: "workspace.showProblems",
      title: "Problems",
      category: "View",
      keybinding: "Alt+6",
      keywords: ["problems", "errors", "warnings", "diagnostics", "inspections"],
      run: () => controllerContext.handleActivateToolWindow("problems"),
    },
    {
      id: "workspace.toggleDocumentationPane",
      title: "Toggle Outline Pane",
      category: "View",
      // IDEA Alt+7 = Structure tool window: show and activate it, or hide
      // it when it is already the active tool window.
      keybinding: "Alt+7",
      keywords: ["right", "outline", "structure", "symbols"],
      run: () => controllerContext.handleActivateToolWindow("structure"),
    },
    {
      id: "workspace.callHierarchy",
      title: "Call Hierarchy",
      category: "Navigation",
      keybinding: "Ctrl+Alt+H",
      keywords: ["callers", "callees", "calls"],
      when: (context) => context.focus === "editor" && !!controllerContext.activeFile
        && !!controllerContext.activeCapabilities?.callHierarchy,
      run: () => void controllerContext.openHierarchy("call"),
    },
    {
      id: "workspace.typeHierarchy",
      title: "Type Hierarchy",
      category: "Navigation",
      keybinding: "Ctrl+H",
      keywords: ["supertypes", "subtypes", "inheritance"],
      when: (context) => context.focus === "editor" && !!controllerContext.activeFile
        && !!controllerContext.activeCapabilities?.typeHierarchy,
      run: () => void controllerContext.openHierarchy("type"),
    },
    {
      id: "workspace.gotoDeclaration",
      title: "Go to Declaration",
      category: "Navigation",
      keybinding: "Ctrl+B",
      keybindings: ["Meta+B"],
      keywords: ["declaration", "jump", "navigate"],
      // ED-PARITY-013: Ctrl+B is the navigation key now, so a blocked press
      // must name the real reason (loading / provider not ready) instead of
      // the generic "No selection" fallback.
      getState: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        const state = (availability: "available" | "disabled", disabledReason?: string) => ({
          availability,
          ...(disabledReason ? { disabledReason } : {}),
          source: "provider" as const,
          scope: "editor" as const,
          freshness: "current" as const,
          completeness: "complete" as const,
        });
        if (context.focus === "tree" || !target.file) return state("disabled", "noEditor");
        if (target.file.loading) return state("disabled", "loading");
        const status = controllerContext.lspFilesRef.current[target.file.key]?.status;
        const capabilities = status?.capabilities;
        const languageId = status?.languageId ?? target.file.languagePath;
        const isEquivalent = isDeclarationDefinitionEquivalentLanguage(languageId, target.file.path);
        const supported = !capabilities || (isEquivalent
          ? capabilities.definition !== false
          : (capabilities.declaration !== false || capabilities.definition !== false));
        if (supported) return state("available");
        return state("disabled", status?.active ? "unsupported" : "providerOffline");
      },
      run: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        if (!target.file || target.position === undefined) return;
        void controllerContext.goToDeclarationRef.current(target.file, target.position);
      },
    },
    {
      id: "workspace.gotoDefinition",
      title: "Go to Definition",
      category: "Navigation",
      // ED-PARITY-013 DEC-013-05: F12 is IDEA Jump to Last Tool Window; Ctrl+B
      // (Go to Declaration) routes to the definition where they coincide.
      keywords: ["declaration", "jump", "navigate"],
      when: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        const capabilities = target.file
          ? controllerContext.lspFilesRef.current[target.file.key]?.status?.capabilities
          : null;
        return context.focus === "editor"
          && !!target.file
          && !target.file.loading
          && (!capabilities || !!capabilities.definition);
      },
      run: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        if (!target.file || target.position === undefined) return;
        void controllerContext.goToDefinition(target.file, target.position);
      },
    },
    {
      id: "workspace.findReferences",
      title: "Find Usages",
      category: "Navigation",
      keybinding: "Alt+F7",
      keywords: ["usages", "references", "callers"],
      when: (context) => context.focus === "editor"
        && (!!controllerContext.activeCapabilities || !controllerContext.lspFilesRef.current[controllerContext.activeKey ?? ""]?.status)
        && !!controllerContext.activeFile,
      run: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        if (!target.file || target.position === undefined) return;
        void controllerContext.findReferencesRef.current(target.file, target.position);
      },
    },
    {
      // §8.20.5 W4: lightweight popup over the SAME immutable session as the
      // tool window. With a live session it just re-presents it; otherwise a
      // fresh scoped Find Usages runs first.
      id: "workspace.showUsages",
      title: "Show Usages",
      category: "Navigation",
      keybinding: "Ctrl+Alt+F7",
      // XWin: Ctrl+Alt+F7 switches virtual terminals on Linux.
      platformKeybindings: { linux: ["Ctrl+Alt+7"] },
      keywords: ["usages", "popup", "lightweight"],
      when: (context) => context.focus === "editor" && !!controllerContext.activeFile,
      run: (context) => {
        const target = controllerContext.resolveEditorTarget(context);
        if (!target.file || target.position === undefined) return;
        const snapshot = controllerContext.usageSessionRef.current?.getCurrent();
        if (snapshot && snapshot.state === "ready" && snapshot.envelope.results.length > 0) {
          controllerContext.setLocationPeek({
            title: `Usages of ${snapshot.symbol.displayName} (${snapshot.envelope.results.length})`,
            locations: snapshot.envelope.results.map(({ role: _role, ...location }) => location),
          });
          return;
        }
        void controllerContext.findReferencesRef.current(target.file, target.position);
      },
    },
    {
      id: "workspace.previousMethod",
      title: "Previous Method",
      category: "Navigation",
      keybinding: "Alt+Up",
      provenance: "unsupported",
      keywords: ["previous", "method", "function", "navigate"],
      when: () => false,
      run: () => {
        controllerContext.setStatusMessage("Previous Method requires a language-specific syntax model (unsupported)");
      },
    },
    {
      id: "workspace.nextMethod",
      title: "Next Method",
      category: "Navigation",
      keybinding: "Alt+Down",
      provenance: "unsupported",
      keywords: ["next", "method", "function", "navigate"],
      when: () => false,
      run: () => {
        controllerContext.setStatusMessage("Next Method requires a language-specific syntax model (unsupported)");
      },
    },
    {
      id: "workspace.previousSibling",
      title: "Previous Sibling",
      category: "Navigation",
      provenance: "unsupported",
      keywords: ["previous", "sibling", "element", "navigate"],
      when: () => false,
      run: () => {
        controllerContext.setStatusMessage("Previous Sibling requires a language-specific syntax model (unsupported)");
      },
    },
    {
      id: "workspace.nextSibling",
      title: "Next Sibling",
      category: "Navigation",
      provenance: "unsupported",
      keywords: ["next", "sibling", "element", "navigate"],
      when: () => false,
      run: () => {
        controllerContext.setStatusMessage("Next Sibling requires a language-specific syntax model (unsupported)");
      },
    },
    {
      id: "workspace.toggleTodosPane",
      title: "Toggle TODOs / Bookmarks",
      category: "View",
      // IDEA Alt+2 = Bookmarks tool window.
      keybinding: "Alt+2",
      keywords: ["todo", "fixme", "bookmark", "markers"],
      run: controllerContext.toggleTodosPane,
    },
    {
      id: "workspace.toggleBookmark",
      title: "Toggle Bookmark",
      category: "Edit",
      keybinding: "F11",
      keywords: ["bookmark", "mark", "line"],
      when: (context) => context.focus === "editor" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: controllerContext.toggleBookmarkAtCursor,
    },
    {
      id: "workspace.toggleBookmarkWithMnemonic",
      title: "Toggle Bookmark with Mnemonic",
      category: "Edit",
      keybinding: "Ctrl+F11",
      keywords: ["bookmark", "mnemonic", "mark", "digit"],
      when: (context) => context.focus === "editor" && !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: () => controllerContext.chooseMnemonicBookmarkAtCursor(),
    },
    {
      id: "workspace.showBookmarks",
      title: "Show Bookmarks",
      category: "View",
      keybinding: "Shift+F11",
      keywords: ["bookmark", "list", "show"],
      run: controllerContext.openTodosPane,
    },
    {
      id: "workspace.jumpToMnemonicBookmark",
      title: "Jump to Mnemonic Bookmark",
      category: "View",
      keywords: ["bookmark", "jump", "mnemonic", "go"],
      run: () => {
        const mnemonicBookmarks = controllerContext.bookmarks.filter((b) => b.mnemonic);
        if (mnemonicBookmarks.length === 0) {
          controllerContext.setStatusMessage("No mnemonic bookmarks set");
          return;
        }
        if (mnemonicBookmarks.length === 1 && mnemonicBookmarks[0].mnemonic) {
          controllerContext.jumpToMnemonicBookmark(mnemonicBookmarks[0].mnemonic);
        } else {
          controllerContext.openTodosPane();
        }
      },
    },
    ...WORKSPACE_BOOKMARK_MNEMONICS.map((mnemonic): WorkspaceCommand => ({
      id: `workspace.jumpToBookmark${mnemonic}`,
      title: `Jump to Bookmark [${mnemonic}]`,
      category: "Navigation",
      keybinding: `Ctrl+${mnemonic}`,
      keybindings: [`Meta+${mnemonic}`],
      keywords: ["bookmark", "jump", "mnemonic", mnemonic.toLowerCase()],
      when: () => !!findBookmarkByMnemonic(controllerContext.bookmarks, mnemonic),
      run: () => controllerContext.jumpToMnemonicBookmark(mnemonic),
    })),
    {
      id: "workspace.activateNavigationBar",
      title: "Jump to Navigation Bar",
      category: "Navigate",
      keybinding: "Alt+Home",
      keywords: ["navbar", "navigation", "bar", "breadcrumbs", "jump"],
      when: (context) => context.focus === "editor" && !!controllerContext.activeFile,
      run: controllerContext.activateNavigationBar,
    },
    {
      id: "workspace.highlightUsagesInFile",
      title: "Highlight Usages in File",
      category: "Navigate",
      keybinding: "Ctrl+Shift+F7",
      keywords: ["highlight", "usages", "occurrences", "symbol"],
      when: (context) => context.focus === "editor" && !!controllerContext.activeFile,
      run: controllerContext.highlightUsagesInFile,
    },
    {
      id: "workspace.nextOccurrence",
      title: "Next Highlighted Occurrence",
      category: "Navigate",
      keybinding: "Ctrl+Alt+Down",
      keywords: ["next", "occurrence", "highlight"],
      when: (context) => context.focus === "editor" && !!controllerContext.occurrenceSessionRef.current,
      run: () => controllerContext.navigateOccurrence("next"),
    },
    {
      id: "workspace.previousOccurrence",
      title: "Previous Highlighted Occurrence",
      category: "Navigate",
      keybinding: "Ctrl+Alt+Up",
      keywords: ["previous", "occurrence", "highlight"],
      when: (context) => context.focus === "editor" && !!controllerContext.occurrenceSessionRef.current,
      run: () => controllerContext.navigateOccurrence("previous"),
    },
    {
      id: "workspace.clearHighlightUsages",
      title: "Clear Highlight Usages",
      category: "Navigate",
      keybinding: "Escape",
      keywords: ["clear", "highlight", "escape"],
      when: (context) => context.focus === "editor" && !!controllerContext.occurrenceSessionRef.current,
      run: controllerContext.clearHighlightUsages,
    },
    {
      id: "workspace.compareWithClipboard",
      title: "Compare with Clipboard",
      category: "Diff",
      keywords: ["diff", "compare", "clipboard"],
      when: () => !!controllerContext.activeFile,
      run: controllerContext.compareWithClipboard,
    },
    {
      id: "workspace.compareWithFile",
      title: "Compare with File…",
      category: "Diff",
      keywords: ["diff", "compare", "file"],
      when: () => !!controllerContext.activeFile,
      run: controllerContext.compareWithFile,
    },
    {
      id: "workspace.compareWithLocalHistory",
      title: "Compare with Local History",
      category: "Diff",
      keywords: ["diff", "compare", "local", "history", "snapshot"],
      when: () => !!controllerContext.activeFile,
      run: controllerContext.compareWithLocalHistory,
    },
    {
      id: "workspace.toggleRenderedDocComments",
      title: "Toggle Rendered Documentation",
      category: "View",
      keybinding: "Ctrl+Alt+Q",
      keywords: ["doc", "render", "documentation", "reader", "comment", "jsdoc", "javadoc"],
      when: () => !!controllerContext.activeFile && isDocCommentRenderingSupported(controllerContext.activeRenderedDocLanguageId),
      run: controllerContext.toggleRenderedDocComments,
    },
    {
      id: "workspace.toggleInlayHints",
      title: `${controllerContext.intelligencePreferences.inlayHintsEnabled ? "Disable" : "Enable"} Inlay Hints`,
      category: "View",
      keywords: ["inlay", "hints", "types", "parameters"],
      run: controllerContext.toggleInlayHints,
    },
    {
      id: "workspace.toggleLanguageInlayHints",
      title: `${controllerContext.activeInlayHintsEnabled ? "Disable" : "Enable"} Inlay Hints for ${controllerContext.activeLanguageId ?? "Current Language"}`,
      category: "View",
      keywords: ["inlay", "language", "hints"],
      when: () => !!controllerContext.activeCapabilities?.inlayHint,
      run: controllerContext.toggleInlayHintsForActiveLanguage,
    },
    {
      id: "workspace.toggleInlineBlame",
      title: `${controllerContext.intelligencePreferences.inlineBlameEnabled ? "Disable" : "Enable"} Inline Git Blame`,
      category: "Git",
      keywords: ["git", "blame", "author", "line"],
      when: () => !!controllerContext.activeGitRoot,
      run: controllerContext.toggleInlineBlame,
    },
    {
      id: "workspace.toggleSoftWrap",
      title: `${controllerContext.activeFileSoftWrap ? "Disable" : "Enable"} Soft Wrap`,
      category: "View",
      keywords: ["wrap", "long lines", "line wrapping"],
      when: (context) => context.focus === "editor" || context.focus === "workspace",
      run: controllerContext.toggleSoftWrap,
    },
    {
      id: "workspace.toggleColumnSelection",
      title: `${controllerContext.columnSelectionMode ? "Disable" : "Enable"} Column Selection Mode`,
      category: "Edit",
      keybinding: "Alt+Shift+Insert",
      keywords: ["rectangular", "block selection", "column mode"],
      when: (context) => context.focus === "editor" || context.focus === "workspace",
      run: controllerContext.toggleColumnSelectionMode,
    },
    {
      id: "workspace.toggleTerminal",
      title: "Toggle Workspace Terminal",
      category: "View",
      keybinding: "Alt+F12",
      keywords: ["terminal", "shell", "bottom"],
      run: () => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId);
        if (ui.bottomDockOpen && ui.bottomDockTab === "terminal") {
          controllerContext.setBottomDockOpen(false);
        } else {
          controllerContext.setBottomDockTab("terminal");
          controllerContext.setBottomDockOpen(true);
          controllerContext.terminalDockRef.current?.focus();
        }
      },
    },
    {
      id: "workspace.runActiveJavaFile",
      title: "Run Current Target",
      category: "Run",
      keybinding: "Shift+F10",
      keybindings: ["Ctrl+Shift+F10"],
      keywords: ["target", "main", "run", "application"],
      when: () => !!controllerContext.activeFile
        && controllerContext.activeFile.ref.kind === "root"
        && !controllerContext.activeFile.library,
      run: () => controllerContext.runActiveJavaFileRef.current(),
    },
    {
      id: "workspace.runContextConfiguration",
      title: "Run Context Configuration",
      category: "Run",
      keybinding: "Ctrl+Shift+F10",
      keybindings: ["Mod-Shift-F10"],
      keywords: ["run context", "run file", "main", "test", "target"],
      when: () => !!controllerContext.activeFile
        && controllerContext.activeFile.ref.kind === "root"
        && !controllerContext.activeFile.library,
      run: () => controllerContext.runActiveJavaFileRef.current(),
    },
    {
      id: "workspace.buildProject",
      title: "Build Project",
      category: "Build",
      keybinding: "Ctrl+F9",
      keywords: ["build", "compile", "maven", "gradle"],
      when: () => controllerContext.roots.length > 0,
      run: () => controllerContext.buildActiveProjectRef.current(false),
    },
    {
      id: "workspace.recompileActiveFile",
      title: controllerContext.activeFile ? `Recompile '${controllerContext.activeFile.title}'` : "Recompile Active File",
      category: "Build",
      keybinding: "Ctrl+Shift+F9",
      keybindings: ["Mod-Shift-F9"],
      keywords: ["compile", "recompile", "single file", "build", "javac"],
      when: () => !!controllerContext.activeFile && !controllerContext.activeFile.library,
      run: () => controllerContext.recompileActiveFileRef.current(),
    },
    {
      id: "workspace.toggleBreakpoint",
      title: "Toggle Line Breakpoint",
      category: "Debug",
      keybinding: "Ctrl+F8",
      keybindings: ["Mod-F8"],
      keywords: ["breakpoint", "toggle breakpoint", "debug"],
      when: () => !!controllerContext.activeFile && !controllerContext.activeFile.library,
      run: () => {
        const cursor = controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId];
        const line = (cursor?.line ?? controllerContext.editorSelectionRef.current.start.line) + 1;
        controllerContext.toggleActiveBreakpointRef.current(line);
      },
    },
    {
      id: "workspace.viewBreakpoints",
      title: "View Breakpoints",
      category: "Debug",
      keybinding: "Ctrl+Shift+F8",
      keybindings: ["Mod-Shift-F8"],
      keywords: ["breakpoint", "manage breakpoints", "condition", "log", "debug"],
      run: () => {
        const cursor = controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId];
        const line = (cursor?.line ?? controllerContext.editorSelectionRef.current.start.line) + 1;
        controllerContext.viewBreakpointsAtCaretRef.current(line);
      },
    },
    {
      id: "workspace.toggleTemporaryBreakpoint",
      title: "Toggle Temporary Line Breakpoint",
      category: "Debug",
      keybinding: "Ctrl+Alt+Shift+F8",
      keywords: ["breakpoint", "temporary", "remove once hit", "debug"],
      when: () => !!controllerContext.activeFile && !controllerContext.activeFile.library,
      run: () => {
        const cursor = controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId];
        const line = (cursor?.line ?? controllerContext.editorSelectionRef.current.start.line) + 1;
        controllerContext.toggleTemporaryBreakpointRef.current(line);
      },
    },
    {
      id: "workspace.toggleBreakpointEnabled",
      title: "Toggle Breakpoint Enabled",
      category: "Debug",
      keywords: ["breakpoint", "enable", "disable", "debug"],
      when: () => !!controllerContext.activeFile && !controllerContext.activeFile.library,
      run: () => {
        const cursor = controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId];
        const line = (cursor?.line ?? controllerContext.editorSelectionRef.current.start.line) + 1;
        controllerContext.toggleActiveBreakpointEnabledRef.current(line);
      },
    },
    {
      id: "workspace.debug.resume",
      title: "Resume Program",
      category: "Debug",
      keybinding: "F9",
      keywords: ["debug", "resume", "continue"],
      when: (context) => context.focus !== "terminal" && controllerContext.debugRef.current?.state?.status === "stopped",
      run: () => { void controllerContext.debugRef.current?.step("continue"); },
    },
    {
      id: "workspace.debug.stepOver",
      title: "Step Over",
      category: "Debug",
      keybinding: "F8",
      keywords: ["debug", "step", "next"],
      when: (context) => context.focus !== "terminal" && controllerContext.debugRef.current?.state?.status === "stopped",
      run: () => { void controllerContext.debugRef.current?.step("stepOver"); },
    },
    {
      id: "workspace.debug.stepInto",
      title: "Step Into",
      category: "Debug",
      keybinding: "F7",
      keywords: ["debug", "step", "into"],
      when: (context) => context.focus !== "terminal" && controllerContext.debugRef.current?.state?.status === "stopped",
      run: () => { void controllerContext.debugRef.current?.step("stepIn"); },
    },
    {
      id: "workspace.debug.stepOut",
      title: "Step Out",
      category: "Debug",
      keybinding: "Shift+F8",
      keywords: ["debug", "step", "out", "return"],
      when: (context) => context.focus !== "terminal" && controllerContext.debugRef.current?.state?.status === "stopped",
      run: () => { void controllerContext.debugRef.current?.step("stepOut"); },
    },
    {
      id: "workspace.debug.stop",
      title: "Stop",
      category: "Debug",
      keybinding: "Ctrl+F2",
      keywords: ["debug", "stop", "terminate"],
      when: (context) => {
        const status = controllerContext.debugRef.current?.state?.status;
        return context.focus !== "terminal" && !!status && status !== "terminated";
      },
      run: () => controllerContext.debugRef.current?.terminate(),
    },
    {
      id: "workspace.debug.evaluateExpression",
      title: "Evaluate Expression…",
      category: "Debug",
      keybinding: "Alt+F8",
      keywords: ["debug", "evaluate", "expression", "inspect"],
      when: (context) => context.focus !== "terminal" && controllerContext.debugRef.current?.state?.status === "stopped",
      run: () => controllerContext.openEvaluateDialogRef.current(),
    },
    {
      id: "workspace.debug.showExecutionPoint",
      title: "Show Execution Point",
      category: "Debug",
      keybinding: "Alt+F10",
      keywords: ["debug", "execution point", "current line"],
      when: () => controllerContext.debugRef.current?.state?.status === "stopped",
      run: () => controllerContext.showDebugExecutionPointRef.current(),
    },
    {
      id: "workspace.toggleMuteBreakpoints",
      title: "Mute / Unmute Breakpoints",
      category: "Debug",
      keywords: ["debug", "breakpoint", "mute", "disable", "pause"],
      run: () => {
        const debugSession = controllerContext.debugRef.current;
        if (!debugSession) return;
        const next = !debugSession.breakpointsMuted;
        debugSession.setBreakpointsMuted(next);
        controllerContext.setStatusMessage(next ? "Breakpoints muted" : "Breakpoints unmuted");
      },
    },
    {
      id: "workspace.showRunTasks",
      title: "Show Run Tasks",
      category: "Run",
      keybinding: "Alt+4",
      keywords: ["run", "task", "script"],
      run: () => controllerContext.handleActivateToolWindow("run"),
    },
    {
      id: "workspace.showAnalysis",
      title: "Show Code Analysis",
      category: "Analyze",
      keywords: ["inspection", "data flow", "diagnostics", "lsp", "psi"],
      run: () => {
        controllerContext.setBottomDockTab("analysis");
        controllerContext.setBottomDockOpen(true);
      },
    },
    {
      id: "workspace.rerunLastTask",
      title: "Rerun Last Task",
      category: "Run",
      keybinding: "Ctrl+F5",
      keywords: ["run", "rerun", "repeat"],
      run: () => {
        if (!controllerContext.runPanelRef.current?.rerunLast()) controllerContext.setStatusMessage("No workspace task has run yet");
      },
    },
    {
      id: "workspace.undoWorkspaceEdit",
      title: controllerContext.workspaceEditHistoryState.undoLabel
        ? `Undo ${controllerContext.workspaceEditHistoryState.undoLabel}`
        : "Undo Workspace Edit",
      category: "Edit",
      keybinding: "Ctrl+Z",
      keybindings: ["Cmd+Z"],
      keywords: ["undo", "workspace edit", "refactor"],
      // ED-AUDIT-008: inside the editor surface the shared document undo
      // (workspace.undo) owns Ctrl+Z and claims the journal through
      // claimWorkspaceHistory. The Actions popup owns its keys and can offer
      // workspace Undo even when its default snapshot points at that editor.
      when: (context) => context.focus !== "tree"
        && context.focus !== "terminal"
        && (context.focus !== "editor" || controllerContext.searchEverywhereOpen)
        && controllerContext.workspaceEditHistoryState.canUndo
        && !controllerContext.workspaceEditHistoryState.busy,
      run: () => controllerContext.requestWorkspaceUndoConfirmation(),
    },
    {
      id: "workspace.redoWorkspaceEdit",
      title: controllerContext.workspaceEditHistoryState.redoLabel
        ? `Redo ${controllerContext.workspaceEditHistoryState.redoLabel}`
        : "Redo Workspace Edit",
      category: "Edit",
      keybinding: "Ctrl+Shift+Z",
      keybindings: ["Cmd+Shift+Z", "Ctrl+Y", "Cmd+Y"],
      keywords: ["redo", "workspace edit", "refactor"],
      when: (context) => context.focus !== "tree"
        && context.focus !== "terminal"
        && context.focus !== "editor"
        && controllerContext.workspaceEditHistoryState.canRedo
        && !controllerContext.workspaceEditHistoryState.busy,
      run: () => void controllerContext.redoWorkspaceEdit(),
    },
    {
      id: "workspace.reviewRefactorRecovery",
      title: "Review Refactor Recovery Entries",
      category: "File",
      keywords: ["recovery", "restore", "refactor", "repair"],
      run: async () => {
        const rootPath = controllerContext.roots[0]?.path;
        if (!rootPath) return;
        const listing = listRefactorRecoveryJournalsV2(rootPath);
        const pending = listing.entries.filter(isPendingRefactorRecoveryEntry);
        if (pending.length === 0) {
          controllerContext.setStatusMessage("No pending recovery entries found");
          return;
        }
        for (const entry of pending) {
          await controllerContext.promptRefactorRecoveryEntry(entry, controllerContext.workspaceInstanceId);
        }
      },
    },
    {
      id: "workspace.save",
      title: "Save Active File",
      category: "File",
      keybinding: "Ctrl+S",
      keybindings: ["Meta+S"],
      when: () => {
        const file = controllerContext.openFilesRef.current[controllerContext.activeKeyRef.current ?? ""];
        return !!file?.dirty && !file.loading && !file.saving;
      },
      run: () => void controllerContext.saveFile(controllerContext.activeKeyRef.current),
    },
    {
      id: "workspace.closeActiveEditorTab",
      title: "Close Active Editor Tab",
      category: "File",
      keybinding: "Ctrl+F4",
      when: () => !!controllerContext.activeKey,
      run: () => {
        if (controllerContext.activeKey) void controllerContext.closeFile(controllerContext.activeKey, controllerContext.activeEditorGroupId);
      },
    },
    {
      id: "workspace.revealActiveFileInTree",
      title: "Reveal Active File in Project Tree",
      category: "Navigation",
      keybinding: "Alt+F1",
      when: () => !!controllerContext.activeKey,
      run: () => {
        if (controllerContext.activeKey) controllerContext.revealEditorTabInTree(controllerContext.activeKey);
      },
    },
    {
      id: "workspace.reload",
      title: "Reload Active File",
      category: "File",
      when: () => !!controllerContext.activeFile && !controllerContext.activeFile.loading,
      run: () => void controllerContext.reloadFile(),
    },
    {
      id: "workspace.refreshTree",
      title: "Refresh Project Tree",
      category: "File",
      run: controllerContext.refreshTree,
    },
    {
      id: "workspace.openGit",
      title: "Open in Git Tab",
      category: "Git",
      when: () => !controllerContext.gitRootsLoading && !!controllerContext.onOpenGitManager && controllerContext.gitRoots.length > 0,
      run: controllerContext.openGitManager,
    },
    {
      // ED-PARITY-018 DEC-018-01: IDEA Alt+9 = the Git tool window.
      id: "workspace.gitToolWindow",
      title: "Git Tool Window",
      category: "Git",
      keybinding: "Alt+9",
      keywords: ["git", "log", "changes", "vcs"],
      run: () => controllerContext.handleActivateToolWindow("git"),
    },
    {
      // ED-PARITY-018 DEC-018-02: IDEA Alt+0 = Commit (changes + message).
      id: "workspace.commitToolWindow",
      title: "Commit Tool Window",
      category: "Git",
      keybinding: "Alt+0",
      keywords: ["commit", "changes", "vcs"],
      run: () => controllerContext.handleActivateToolWindow("git"),
    },
    {
      id: "workspace.toggleSyncSplitScroll",
      title: "View: Toggle Synchronized Split Scrolling",
      category: "View",
      when: () => !!controllerContext.splitOrientation,
      run: () => {
        controllerContext.setSyncSplitScroll((v) => {
          const next = !v;
          controllerContext.setStatusMessage(next ? "Synchronized split scrolling enabled" : "Synchronized split scrolling disabled");
          return next;
        });
      },
    },
    // §8.19.6 R5-b split management actions.
    {
      id: "workspace.splitRight",
      title: "Split Editor Right",
      category: "View",
      keywords: ["split", "vertical", "editor"],
      when: () => !!controllerContext.activeKey,
      run: () => {
        controllerContext.splitEditor("vertical");
        return true;
      },
    },
    {
      id: "workspace.splitDown",
      title: "Split Editor Down",
      category: "View",
      keywords: ["split", "horizontal", "editor"],
      when: () => !!controllerContext.activeKey,
      run: () => {
        controllerContext.splitEditor("horizontal");
        return true;
      },
    },
    {
      id: "workspace.goToNextSplit",
      title: "Go to Next Split",
      category: "View",
      keywords: ["next", "splitter", "navigate"],
      run: () => controllerContext.goToAdjacentSplit(1),
    },
    {
      id: "workspace.goToPreviousSplit",
      title: "Go to Previous Split",
      category: "View",
      keywords: ["previous", "splitter", "navigate"],
      run: () => controllerContext.goToAdjacentSplit(-1),
    },
    {
      id: "workspace.moveTabToNextSplit",
      title: "Move Tab to Next Split",
      category: "View",
      keywords: ["move", "tab", "next", "split"],
      when: () => !!controllerContext.activeKey,
      run: () => controllerContext.moveActiveTabToAdjacentSplit(1),
    },
    {
      id: "workspace.moveTabToPreviousSplit",
      title: "Move Tab to Previous Split",
      category: "View",
      keywords: ["move", "tab", "previous", "split"],
      when: () => !!controllerContext.activeKey,
      run: () => controllerContext.moveActiveTabToAdjacentSplit(-1),
    },
    {
      id: "workspace.equalizeSplitProportions",
      title: "Equalize Split Proportions",
      category: "View",
      keywords: ["equalize", "proportions", "ratios", "split"],
      when: () => !!controllerContext.splitOrientation,
      run: controllerContext.equalizeActiveSplitRatios,
    },
    {
      id: "workspace.stretchActiveSplit",
      title: "Stretch Active Split",
      category: "View",
      keywords: ["stretch", "widen", "grow", "split"],
      when: () => !!controllerContext.splitOrientation,
      run: controllerContext.stretchActiveSplit,
    },
    {
      id: "workspace.unsplitAll",
      title: "Unsplit All",
      category: "View",
      keywords: ["unsplit", "close splits", "single editor"],
      when: () => !!controllerContext.splitOrientation,
      run: controllerContext.unsplitAllWindows,
    },
    {
      id: "workspace.tree.openLooseFile",
      title: "Open Loose File",
      category: "File",
      run: () => void controllerContext.openLooseFile(),
    },
    {
      id: "workspace.tree.addFolder",
      title: "Add Folder to Workspace",
      category: "File",
      run: () => void controllerContext.addRoot(),
    },
    {
      id: "workspace.tree.open",
      title: "Open Selected File",
      category: "File",
      when: (context) => context.focus === "tree",
      run: (context) => {
        if (controllerContext.treeContextMenuSessionRef.current) {
          controllerContext.treeContextMenuSessionRef.current.consumed = true;
        }
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        const selection = payload?.selection ?? controllerContext.selected;
        if (selection?.kind === "file") void controllerContext.requestTreeOpen(selection.ref);
      },
    },
    {
      id: "workspace.tree.newFile",
      title: "New File",
      category: "File",
      when: (context) => context.focus !== "tree" || !!controllerContext.selectedRootDirectory,
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void controllerContext.createFile(payload?.directory);
      },
    },
    {
      id: "workspace.tree.newDirectory",
      title: "New Directory",
      category: "File",
      when: (context) => context.focus !== "tree" || !!controllerContext.selectedRootDirectory,
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void controllerContext.createDir(payload?.directory);
      },
    },
    {
      id: "workspace.tree.newJavaClass",
      title: "New Java Class...",
      category: "File",
      when: (context) => context.focus !== "tree" || !!controllerContext.selectedRootDirectory,
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        controllerContext.openNewJavaClassDialog(payload?.directory);
      },
    },
    {
      id: "workspace.tree.rename",
      title: "Rename Tree Selection",
      category: "Refactor",
      keybinding: "F2",
      when: (context) => context.focus === "tree" && !!((context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? controllerContext.selected),
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void controllerContext.renameSelected(payload?.selection);
      },
    },
    {
      id: "workspace.tree.delete",
      title: "Delete or Remove Tree Selection",
      category: "File",
      keybinding: "Delete",
      when: (context) => context.focus === "tree" && !!((context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? controllerContext.selected),
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        void controllerContext.deleteSelected(payload?.selection);
      },
    },
    {
      id: "workspace.tree.addToGitignore",
      title: "Add Tree Selection to .gitignore",
      category: "Git",
      keywords: ["git", "ignore", "exclude"],
      when: (context) => {
        const selection = (context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? controllerContext.selected;
        return context.focus === "tree" && (
          selection?.kind === "dir"
          || (selection?.kind === "file" && selection.ref.kind === "root")
        );
      },
      run: (context) => {
        const selection = (context.payload as WorkspaceTreeCommandPayload | undefined)?.selection ?? controllerContext.selected;
        if (selection?.kind === "dir") {
          void controllerContext.ignoreWorkspacePath(selection.rootId, selection.path, true);
        } else if (selection?.kind === "file" && selection.ref.kind === "root") {
          void controllerContext.ignoreWorkspacePath(selection.ref.rootId, selection.ref.path, false);
        }
      },
    },
    {
      id: "workspace.tree.findInDirectory",
      title: "Find in Selected Directory",
      category: "Search",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        controllerContext.findInDirectory(payload?.path ?? "");
      },
    },
    {
      id: "workspace.tree.copyPath",
      title: "Copy Absolute Path",
      category: "File",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        if (payload?.rootId !== undefined && payload.path !== undefined) {
          void controllerContext.copyTreePath(payload.rootId, payload.path, true);
        }
      },
    },
    {
      id: "workspace.tree.copyRelativePath",
      title: "Copy Relative Path",
      category: "File",
      when: (context) => context.focus === "tree",
      run: (context) => {
        const payload = context.payload as WorkspaceTreeCommandPayload | undefined;
        if (payload?.rootId !== undefined && payload.path !== undefined) {
          void controllerContext.copyTreePath(payload.rootId, payload.path, false);
        }
      },
    },
    {
      id: "workspace.openKeymapCheatsheet",
      title: "Keyboard Shortcuts (Keymap)",
      category: "Help",
      keybinding: "Ctrl+Alt+/",
      keybindings: ["Meta+Alt+/", "Meta+K Meta+S"],
      keywords: ["keymap", "shortcuts", "hotkeys", "cheat sheet", "intellij"],
      run: () => controllerContext.setKeymapCheatSheetOpen(true),
    },
    {
      id: "workspace.showCoverage",
      title: "Show Code Coverage",
      category: "Analyze",
      keywords: ["coverage", "jacoco", "lcov", "tests", "lines"],
      run: () => {
        controllerContext.setBottomDockTab("coverage");
        controllerContext.setBottomDockOpen(true);
        if (!controllerContext.coverageReport) void controllerContext.scanWorkspaceCoverage();
      },
    },
    {
      id: "workspace.openDapAdapterGuide",
      title: "DAP Debug Adapter Setup Guide",
      category: "Debug",
      keywords: ["dap", "debugpy", "delve", "lldb", "gdb", "js-debug", "adapter", "guide", "setup"],
      run: () => controllerContext.setDapGuideOpen(true),
    },
    {
      id: "workspace.runToCursor",
      title: "Run to Cursor",
      category: "Debug",
      keybinding: "Alt+F9",
      // IDEA "Default for XWin" moves Run to Cursor off the window-manager key.
      platformKeybindings: { linux: ["Shift+Alt+9"] },
      keywords: ["debug", "run", "cursor", "break"],
      when: (context) => {
        if (context.focus === "tree" || context.focus === "terminal") return false;
        const session = controllerContext.debugRef.current;
        return !!session?.state && session.state.status === "stopped";
      },
      run: (context) => {
        const session = controllerContext.debugRef.current;
        const target = controllerContext.resolveEditorTarget(context);
        const absolute = target.file ? controllerContext.absolutePathForOpenFile(target.file) : null;
        if (!session?.state || !target.file || !absolute || !target.position) return;
        session.runToCursor(normalizeFsPath(absolute), target.position.line + 1);
      },
    },
    {
      id: "workspace.addDataBreakpoint",
      title: "Add Data Breakpoint",
      category: "Debug",
      keywords: ["debug", "breakpoint", "field", "watch", "data"],
      when: (context) => {
        if (context.focus === "tree" || context.focus === "terminal") return false;
        const session = controllerContext.debugRef.current;
        return !!session?.state
          && session.state.status === "stopped"
          && session.capabilities.supportsDataBreakpoints === true;
      },
      run: (context) => {
        const payload = context.payload as { name?: string; frameId?: number } | undefined;
        const name = typeof payload?.name === "string" ? payload.name : null;
        const session = controllerContext.debugRef.current;
        if (!name || !session) return;
        const frameId = payload?.frameId
          ?? session.state?.selectedFrameId
          ?? session.state?.frames[0]?.id
          ?? undefined;
        void session.addDataBreakpoint({ name, frameId }).then((result) => {
          controllerContext.setStatusMessage(result.message);
          if (result.added) {
            controllerContext.setBottomDockTab("debug");
            controllerContext.setBottomDockOpen(true);
          }
        });
      },
    },
  ];
}
