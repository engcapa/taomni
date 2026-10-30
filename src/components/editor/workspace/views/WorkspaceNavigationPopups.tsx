import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { LspMessageRequestDialog } from "../LspMessageRequestDialog";
import { type GoToSymbolItem } from "../SearchEverywhere";
import { StructuralSearchDialog } from "../StructuralSearchDialog";
import { TabSwitcher } from "../TabSwitcher";
import { UsagesScopeDialog } from "../UsagesScopeDialog";
import { WorkspacePopupsHost } from "../WorkspacePopupsHost";
import { RECENT_FILES_TOOL_WINDOWS } from "../controller/model";
import { useReferenceDocumentation } from "../hooks/useReferenceDocumentation";
import { useWorkspaceKeyboard } from "../hooks/useWorkspaceKeyboard";
import { useWorkspaceKeymap } from "../hooks/useWorkspaceKeymap";
import { useWorkspaceLibrarySources } from "../hooks/useWorkspaceLibrarySources";
import { useWorkspaceReferenceSessions } from "../hooks/useWorkspaceReferenceSessions";
import { useWorkspaceStructure } from "../hooks/useWorkspaceStructure";
import { useWorkspaceToolWindowRouting } from "../hooks/useWorkspaceToolWindowRouting";
import { useWorkspaceToolWindows } from "../hooks/useWorkspaceToolWindows";
import { useWorkspaceTreeInteractions } from "../hooks/useWorkspaceTreeInteractions";
import { useWorkspaceUiActions } from "../hooks/useWorkspaceUiActions";
import { useWorkspaceUsages } from "../hooks/useWorkspaceUsages";
import { useWorkspaceUsagesState } from "../hooks/useWorkspaceUsagesState";
import { type WorkspaceLocationController } from "../navigationHistoryModel";
import { useStructuralSearchSession } from "../useStructuralSearchSession";
import { useWorkspaceActionsController } from "../useWorkspaceActionsController";
import { useWorkspaceLspClientEvents } from "../useWorkspaceLspClientEvents";
import { useWorkspaceNavigation } from "../useWorkspaceNavigation";
import { useWorkspaceSemanticIndex } from "../useWorkspaceSemanticIndex";
import { useWorkspaceHost } from "../workspaceHostIntegration";
import { useWorkspaceActionProjection } from "../hooks/useWorkspaceActionProjection";
import type { ActionSnapshotItem } from "../workspaceActionHost";


export interface WorkspaceNavigationPopupsProps {
  keyboard: ReturnType<typeof useWorkspaceKeyboard>;
  searchEverywhereOpen: boolean;
  searchEverywhereMode: import("../SearchEverywhere").SearchEverywhereMode;
  navigation: ReturnType<typeof useWorkspaceNavigation>;
  actionsController: ReturnType<typeof useWorkspaceActionsController>;
  seSymbolsAvailable: boolean;
  semanticIndex: ReturnType<typeof useWorkspaceSemanticIndex>;
  fetchWorkspaceSymbols: (query: string) => Promise<import("../SearchEverywhere").GoToSymbolQueryResult>;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  openWorkspaceSymbol: (symbol: GoToSymbolItem, options?: { split: boolean; }) => Promise<void>;
  runSearchEverywhereCommand: (entry: ActionSnapshotItem) => void;
  keymap: ReturnType<typeof useWorkspaceKeymap>;
  toolWindowRouting: ReturnType<typeof useWorkspaceToolWindowRouting>;
  recentFilesOpen: boolean;
  recentEntries: import("../RecentFilesPopup").RecentFileEntry[];
  recentAdvanceNonce: number;
  toolWindowActions: ReturnType<typeof useWorkspaceToolWindows>;
  workspaceInstanceId: string;
  workspaceLocationControllerRef: import("react").RefObject<WorkspaceLocationController>;
  navigationHistoryFacade: import("../navigationHistoryModel").NavigationHistoryFacade;
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  librarySources: ReturnType<typeof useWorkspaceLibrarySources>;
  roots: CodeWorkspaceRootInfo[];
  structureOpen: boolean;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  structureSymbols: import("../../../../lib/editor/lsp").LspDocumentSymbol[];
  structureLoading: boolean;
  structureUnavailable: string | null;
  structureSyntaxOnly: boolean;
  structure: ReturnType<typeof useWorkspaceStructure>;
  quickDocOpen: boolean;
  quickDocContent: import("../referenceDocumentation").ReferenceContentEnvelope | null;
  documentation: ReturnType<typeof useReferenceDocumentation>;
  referenceSessions: ReturnType<typeof useWorkspaceReferenceSessions>;
  locationPeek: import("../LocationPeek").LocationPeekState | null;
  treeInteractions: ReturnType<typeof useWorkspaceTreeInteractions>;
  visible: boolean;
  structuralSearch: ReturnType<typeof useStructuralSearchSession>;
  usages: ReturnType<typeof useWorkspaceUsagesState>;
  usagesActions: ReturnType<typeof useWorkspaceUsages>;
  setStatusMessage: (message: string) => void;
  lspClientEvents: ReturnType<typeof useWorkspaceLspClientEvents>;
}

export function WorkspaceNavigationPopups(props: WorkspaceNavigationPopupsProps) {
  const host = useWorkspaceHost();
  const { snapshot } = useWorkspaceActionProjection(props.actionsController.projection);
  const {
    keyboard,
    searchEverywhereOpen,
    searchEverywhereMode,
    navigation,
    seSymbolsAvailable,
    semanticIndex,
    fetchWorkspaceSymbols,
    uiActions,
    openWorkspaceSymbol,
    runSearchEverywhereCommand,
    keymap,
    toolWindowRouting,
    recentFilesOpen,
    recentEntries,
    recentAdvanceNonce,
    toolWindowActions,
    workspaceInstanceId,
    workspaceLocationControllerRef,
    navigationHistoryFacade,
    openFiles,
    openFile,
    librarySources,
    roots,
    structureOpen,
    activeFile,
    structureSymbols,
    structureLoading,
    structureUnavailable,
    structureSyntaxOnly,
    structure,
    quickDocOpen,
    quickDocContent,
    documentation,
    referenceSessions,
    locationPeek,
    treeInteractions,
    visible,
    structuralSearch,
    usages,
    usagesActions,
    setStatusMessage,
    lspClientEvents,
  } = props;
  return (<><TabSwitcher
    open={keyboard.tabSwitcherOpen}
    entries={keyboard.switcherSnapshot?.editors ?? []}
    toolWindows={keyboard.switcherSnapshot?.tools ?? []}
    selectedIndex={keyboard.tabSwitcherIndex}
    onHover={keyboard.setTabSwitcherIndex}
    onCommit={keyboard.commitTabSwitcher}
    onCancel={() => {
      keyboard.setTabSwitcherOpen(false);
      keyboard.setSwitcherSnapshot(null);
    }}
  />
    <WorkspacePopupsHost
      searchEverywhereOpen={searchEverywhereOpen}
      searchEverywhereMode={searchEverywhereMode}
      goToFileItems={navigation.goToFileItems}
      goToFileLoading={navigation.goToFileLoading}
      goToFileTruncated={navigation.goToFileTruncated}
      actionSnapshots={snapshot.filter((entry) => entry.id !== "workspace.goToFile")}
      symbolsAvailable={seSymbolsAvailable}
      semanticIndex={semanticIndex.snapshot}
      fetchWorkspaceSymbols={fetchWorkspaceSymbols}
      onCloseSearchEverywhere={() => uiActions.setSearchEverywhereOpen(false)}
      onOpenFileItem={navigation.openGoToFileItem}
      onOpenSymbol={(symbol, options) => void openWorkspaceSymbol(symbol, options)}
      onRunCommand={(commandId) => {
        const entry = snapshot.find((item) => item.id === commandId);
        if (entry) runSearchEverywhereCommand(entry);
      }}
      onAssignShortcut={(commandId) => {
        // ED-PARITY-013 DEC-013-03: Find Action Alt+Enter = Assign Shortcut.
        uiActions.setSearchEverywhereOpen(false);
        keymap.setKeymapAssignActionId(commandId);
        keymap.setKeymapSettingsOpen(true);
      }}
      onSearchText={(query) => {
        uiActions.setSearchEverywhereOpen(false);
        toolWindowRouting.setBottomDockOpen(true);
        toolWindowRouting.setBottomDockTab("search");
        uiActions.setSearchFocusNonce((nonce) => nonce + 1);
        uiActions.setSearchQueryPreset((current) => ({ value: query, nonce: current.nonce + 1 }));
      }}
      recentFilesOpen={recentFilesOpen}
      recentEntries={recentEntries}
      recentAdvanceNonce={recentAdvanceNonce}
      recentChangedOnly={navigation.recentChangedOnly}
      onCloseRecent={() => uiActions.setRecentFilesOpen(false)}
      onPickRecent={navigation.pickRecentFile}
      onToggleRecentChangedOnly={() => navigation.openRecentFiles({ changedOnly: !navigation.recentChangedOnly })}
      recentToolWindows={RECENT_FILES_TOOL_WINDOWS}
      onActivateRecentToolWindow={(id) => {
        uiActions.setRecentFilesOpen(false);
        toolWindowActions.handleActivateToolWindow(id);
      }}
      onOpenRecentLocationsFromRecent={() => {
        uiActions.setRecentFilesOpen(false);
        uiActions.setRecentLocationsChangedOnly(false);
        uiActions.setRecentLocationsOpen(true);
      }}
      recentLocationsOpen={uiActions.recentLocationsOpen}
      recentLocationsChangedOnly={uiActions.recentLocationsChangedOnly}
      workspaceId={workspaceInstanceId}
      locationController={workspaceLocationControllerRef.current}
      navigationFacade={navigationHistoryFacade}
      onCloseRecentLocations={() => uiActions.setRecentLocationsOpen(false)}
      onPickRecentLocation={(loc) => {
        uiActions.setRecentLocationsOpen(false);
        const targetOpen = openFiles[loc.fileIdentity];
        if (targetOpen) {
          void openFile(targetOpen.ref).then(() => {
            librarySources.revealEditorLocation(targetOpen.key, {
              start: { line: loc.line, character: loc.character },
              end: { line: loc.line, character: loc.character },
            });
          });
        } else {
          const matchingRoot = roots.find((r) => loc.filePath.startsWith(r.path));
          if (matchingRoot) {
            const relPath = loc.filePath.slice(matchingRoot.path.length).replace(/^\/+/, "");
            void openFile({ kind: "root", rootId: matchingRoot.id, path: relPath }).then(() => {
              const key = `root:${matchingRoot.id}:${relPath}`;
              librarySources.revealEditorLocation(key, {
                start: { line: loc.line, character: loc.character },
                end: { line: loc.line, character: loc.character },
              });
            });
          } else {
            void openFile({ kind: "loose", id: loc.fileIdentity, path: loc.filePath }).then(() => {
              librarySources.revealEditorLocation(loc.fileIdentity, {
                start: { line: loc.line, character: loc.character },
                end: { line: loc.line, character: loc.character },
              });
            });
          }
        }
      }}
      structureOpen={structureOpen}
      structureFileTitle={activeFile?.title ?? null}
      structureSymbols={structureSymbols}
      structureLoading={structureLoading}
      structureUnavailable={structureUnavailable}
      structureSyntaxOnly={structureSyntaxOnly}
      onCloseStructure={() => uiActions.setStructureOpen(false)}
      onPickStructure={structure.pickStructureSymbol}
      quickDocOpen={quickDocOpen}
      quickDocContent={quickDocContent}
      onCloseQuickDoc={() => uiActions.setQuickDocOpen(false)}
      onPinQuickDoc={documentation.pinQuickDocumentation}
      onOpenQuickDocSource={documentation.openReferenceSource}
      quickDocCanGoBack={referenceSessions.referenceHistory.canGoBack}
      quickDocCanGoForward={referenceSessions.referenceHistory.canGoForward}
      onQuickDocBack={documentation.referenceHistoryBack}
      onQuickDocForward={documentation.referenceHistoryForward}
      locationPeek={locationPeek}
      onCloseLocationPeek={() => uiActions.setLocationPeek(null)}
      onOpenLocation={(location) => {
        uiActions.setLocationPeek(null);
        void librarySources.openLspLocation(location);
      }}
    />
    {host ? createPortal(treeInteractions.treeContextMenu, document.body) : treeInteractions.treeContextMenu}
    {treeInteractions.editorContextMenu}
    {visible ? <StructuralSearchDialog session={structuralSearch} /> : null}
    <UsagesScopeDialog
      open={!!usages.usagesScopeDialog?.open}
      symbolHint={usages.usagesScopeDialog?.file.subtitle ?? null}
      onConfirm={usagesActions.confirmUsagesScope}
      onCancel={() => {
        usages.setUsagesScopeDialog(null);
        setStatusMessage("Find Usages cancelled");
      }}
    />
    {visible && lspClientEvents.messageRequest && (
      <LspMessageRequestDialog
        request={lspClientEvents.messageRequest}
        onSelect={lspClientEvents.resolveMessageRequest}
      />
    )}
  </>);
}
import { createPortal } from "react-dom";
