import { type ReactNode } from "react";
import type { CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { FileTreePane } from "../FileTreePane";
import { OutlinePane } from "../OutlinePane";
import { ProjectTree } from "../ProjectTree";
import {
  CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE,
  CODE_WORKSPACE_MAX_TREE_FONT_SIZE,
  CODE_WORKSPACE_MIN_TREE_FONT_SIZE,
  type LspFileState,
  type TreeViewMode,
} from "../codeWorkspaceModel";
import { useReferenceDocumentation } from "../hooks/useReferenceDocumentation";
import { useWorkspaceAppearance } from "../hooks/useWorkspaceAppearance";
import { useWorkspaceEditorTelemetry } from "../hooks/useWorkspaceEditorTelemetry";
import { useWorkspaceGitDecorations } from "../hooks/useWorkspaceGitDecorations";
import { useWorkspaceReferenceSessions } from "../hooks/useWorkspaceReferenceSessions";
import { useWorkspaceStructure } from "../hooks/useWorkspaceStructure";
import { useWorkspaceToolWindows } from "../hooks/useWorkspaceToolWindows";
import { useWorkspaceTreeFocusState } from "../hooks/useWorkspaceTreeFocusState";
import { useWorkspaceTreeInteractions } from "../hooks/useWorkspaceTreeInteractions";
import { useWorkspaceUiActions } from "../hooks/useWorkspaceUiActions";
import { DocumentationPane } from "../panels/DocumentationPane";
import { useWorkspaceFileActions } from "../useWorkspaceFileActions";
import { useWorkspaceTreeData } from "../useWorkspaceTreeData";
import { type WorkspaceCommandContext } from "../workspaceCommands";
import { createWorkspaceDockContents } from "./createWorkspaceDockContents";


export interface CreateWorkspaceSideContentsContext {
  treeFocus: ReturnType<typeof useWorkspaceTreeFocusState>;
  appearance: ReturnType<typeof useWorkspaceAppearance>;
  treeInteractions: ReturnType<typeof useWorkspaceTreeInteractions>;
  treeFilter: string;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  treeViewMode: import("../treeToolbarChrome").FileTreeViewMode;
  setTreeViewMode: (mode: TreeViewMode) => void;
  languagePanelOpen: boolean;
  toolWindowActions: ReturnType<typeof useWorkspaceToolWindows>;
  executeWorkspaceCommand: (commandId: string, context?: WorkspaceCommandContext) => boolean;
  fileActions: ReturnType<typeof useWorkspaceFileActions>;
  selected: import("../codeWorkspaceModel").TreeSelection | null;
  activeKey: string | null;
  toolWindowOptionsItems: (id: string) => import("../../../ContextMenu").MenuItem[];
  treeShowDetails: boolean;
  setTreeShowDetails: (value: boolean) => void;
  roots: CodeWorkspaceRootInfo[];
  looseFiles: CodeWorkspaceLooseFileInfo[];
  treeData: ReturnType<typeof useWorkspaceTreeData>;
  expandedRoots: Set<string>;
  expandedDirs: Set<string>;
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  gitDecorations: ReturnType<typeof useWorkspaceGitDecorations>;
  projectTreeHandlers: Pick<Parameters<typeof ProjectTree>[0], "onToggleRoot" | "onToggleDir" | "onSelect" | "onOpenFile" | "onContextMenu">;
  telemetry: ReturnType<typeof useWorkspaceEditorTelemetry>;
  activeEditorGroupId: string;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  activeLspState: LspFileState | null;
  activeCapabilities: import("../../../../lib/editor/lsp").LspCapabilitySummary | null;
  structure: ReturnType<typeof useWorkspaceStructure>;
  pinnedDoc: import("../referenceDocumentation").ReferenceContentEnvelope | null;
  pinnedDocLocked: boolean;
  documentation: ReturnType<typeof useReferenceDocumentation>;
  referenceSessions: ReturnType<typeof useWorkspaceReferenceSessions>;
  dockContents: ReturnType<typeof createWorkspaceDockContents>;
}

export function createWorkspaceSideContents(context: CreateWorkspaceSideContentsContext) {
  const {
    treeFocus,
    appearance,
    treeInteractions,
    treeFilter,
    uiActions,
    treeViewMode,
    setTreeViewMode,
    languagePanelOpen,
    toolWindowActions,
    executeWorkspaceCommand,
    fileActions,
    selected,
    activeKey,
    treeShowDetails,
    setTreeShowDetails,
    roots,
    looseFiles,
    treeData,
    expandedRoots,
    expandedDirs,
    openFiles,
    gitDecorations,
    projectTreeHandlers,
    telemetry,
    activeEditorGroupId,
    activeFile,
    activeLspState,
    activeCapabilities,
    structure,
    pinnedDoc,
    pinnedDocLocked,
    documentation,
    referenceSessions,
    dockContents,
  } = context;

  // ED-PARITY-024: every tool window renders once into a re-parentable host;
  // the area showing it adopts the host node (state survives moves).
  const toolWindowContents: { id: string; label: string; content: ReactNode; }[] = [
    {
      id: "project",
      label: "Project",
      content: (
        <FileTreePane
          paneRef={treeFocus.treePaneRef}
          style={appearance.treePaneStyle}
          onKeyDown={treeInteractions.handleTreeKeyDown}
          filter={treeFilter}
          onFilterChange={uiActions.setTreeFilter}
          viewMode={treeViewMode}
          onViewModeChange={setTreeViewMode}
          fontSize={appearance.treeFontSize}
          minFontSize={CODE_WORKSPACE_MIN_TREE_FONT_SIZE}
          maxFontSize={CODE_WORKSPACE_MAX_TREE_FONT_SIZE}
          defaultFontSize={CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE}
          onFontSizeChange={appearance.setTreeFontSize}
          collapsed={!languagePanelOpen}
          onToggleCollapse={toolWindowActions.toggleProjectTree}
          onOpenFile={() => executeWorkspaceCommand("workspace.tree.openLooseFile", { focus: "tree" })}
          onAddFolder={() => executeWorkspaceCommand("workspace.tree.addFolder", { focus: "tree" })}
          canCreate={!!fileActions.selectedRootDirectory}
          canMutateSelection={!!selected}
          onCreateFile={() => executeWorkspaceCommand("workspace.tree.newFile", { focus: "tree" })}
          onCreateDirectory={() => executeWorkspaceCommand("workspace.tree.newDirectory", { focus: "tree" })}
          onRename={() => executeWorkspaceCommand("workspace.tree.rename", { focus: "tree" })}
          onDelete={() => executeWorkspaceCommand("workspace.tree.delete", { focus: "tree" })}
          onSelectOpenedFile={activeKey ? () => treeInteractions.revealEditorTabInTree(activeKey) : undefined}
          onExpandAll={treeInteractions.expandAllProjectTree}
          onCollapseAll={treeInteractions.collapseAllProjectTree}
          toolWindowOptions={() => context.toolWindowOptionsItems("project")}
          showDetails={treeShowDetails}
          onShowDetailsChange={setTreeShowDetails}
        >
          <ProjectTree
            showDetails={treeShowDetails}
            roots={roots}
            looseFiles={looseFiles}
            directories={treeData.directories}
            compactChains={treeData.compactChains}
            flatFiles={treeData.flatFiles}
            treeViewMode={treeViewMode}
            treeFilter={treeFilter}
            expandedRoots={expandedRoots}
            expandedDirs={expandedDirs}
            selected={selected}
            activeKey={activeKey}
            openFiles={openFiles}
            gitChangeByRootPath={gitDecorations.gitChangeByRootPath}
            {...projectTreeHandlers}
          />
        </FileTreePane>
      ),
    },
    {
      id: "structure",
      label: "Structure",
      content: (
        <OutlinePane
          symbols={telemetry.breadcrumbSymbolsByGroup[activeEditorGroupId] ?? []}
          position={telemetry.cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 }}
          loading={!!activeFile && (!!activeLspState?.syncing || (activeCapabilities?.documentSymbol === true && !activeLspState?.status))}
          unavailableReason={!activeFile
            ? "Open a file to view its outline"
            : activeCapabilities?.documentSymbol === false
              ? "Document symbols are not supported by this language server"
              : null}
          onPick={structure.pickOutlineSymbol}
        />
      ),
    },
    {
      id: "documentation",
      label: "Documentation",
      content: (
        <DocumentationPane
          content={pinnedDoc}
          locked={pinnedDocLocked}
          onUnlock={() => uiActions.setPinnedDocLocked(false)}
          onOpenSource={documentation.openReferenceSource}
          canGoBack={referenceSessions.referenceHistory.canGoBack}
          canGoForward={referenceSessions.referenceHistory.canGoForward}
          onBack={documentation.referenceHistoryBack}
          onForward={documentation.referenceHistoryForward}
          onClear={() => {
            uiActions.setPinnedDoc(null);
            uiActions.setPinnedDocLocked(false);
          }}
        />
      ),
    },
    ...dockContents.bottomDockTabs.map((tab) => ({ id: tab.id, label: tab.label, content: tab.content })),
  ];
  return { toolWindowContents };
}
