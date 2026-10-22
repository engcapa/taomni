import { useCallback, useState } from "react";
import { type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { useProjectFactsStore } from "../../../../stores/projectFactsStore";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { type AutoImportCandidate } from "../autoImportModel";
import { type WorkspaceEditApplyOptions } from "../controller/mutationTypes";
import { createCreateJavaClassFromPlan } from "../controller/treeActions";
import { useWorkspaceFileActions } from "../useWorkspaceFileActions";
import { useWorkspaceGitSnapshots } from "../useWorkspaceGitSnapshots";
import { useWorkspaceTreeModel } from "./useWorkspaceTreeModel";
import { useWorkspaceUiActions } from "./useWorkspaceUiActions";


export interface UseWorkspaceJavaCreationContext {
  fileActions: ReturnType<typeof useWorkspaceFileActions>;
  setStatusMessage: (message: string) => void;
  projectTree: ReturnType<typeof useWorkspaceTreeModel>;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: WorkspaceEditApplyOptions) => Promise<import("../workspaceEditApply").WorkspaceEditApplyOutcome[]>;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  gitSnapshotOwner: ReturnType<typeof useWorkspaceGitSnapshots>;
}

export function useWorkspaceJavaCreation(context: UseWorkspaceJavaCreationContext) {
  const { fileActions, setStatusMessage, projectTree, applyLspWorkspaceEdit, uiActions, openFile, gitSnapshotOwner } = context;

  const [newJavaClassDialogState, setNewJavaClassDialogState] = useState<{
    open: boolean;
    targetDirectory: string;
    root: CodeWorkspaceRootInfo;
    dirRelPath: string;
    sourceRoots: readonly string[];
    existingFiles: readonly string[];
    projectFactsStatus: string;
    projectFactsGeneration: number;
    projectFactsFingerprint: string | null;
  } | null>(null);

  const [fileTemplateSettingsOpen, setFileTemplateSettingsOpen] = useState(false);
  const [autoImportSettingsOpen, setAutoImportSettingsOpen] = useState(false);
  const [autoImportCandidatePrompt, setAutoImportCandidatePrompt] = useState<{
    candidates: readonly AutoImportCandidate[];
    onSelect: (candidate: AutoImportCandidate) => void;
    onClose: () => void;
  } | null>(null);

  const openNewJavaClassDialog = useCallback((target?: { rootId: string; path: string; }) => {
    const directory = target ?? fileActions.selectedRootDirectory;
    if (!directory) {
      setStatusMessage("Add a folder before creating Java classes");
      return;
    }
    const root = projectTree.findRoot(directory.rootId);
    if (!root) return;

    const targetDir = directory.path ? `${root.path}/${directory.path}` : root.path;
    const facts = useProjectFactsStore.getState().getWorkspaceFacts(root.path);
    const projectFactsStatus = facts?.status;
    const isFactsReady = facts?.status === "ready";
    const sourceRoots = isFactsReady && facts?.structure
      ? facts.structure.modules.flatMap((m) =>
        m.sourceSets
          .filter((s) => s.kind === "main" || s.kind === "test")
          .flatMap((s) => s.roots),
      )
      : [];

    const dirKey = `root:${root.id}:${directory.path}`;
    const dirEntries = projectTree.treeData.directories[dirKey]?.entries ?? [];
    const existingFiles = dirEntries.map((f) => `${targetDir}/${f.name}`);

    setNewJavaClassDialogState({
      open: true,
      targetDirectory: targetDir,
      root,
      dirRelPath: directory.path,
      sourceRoots,
      existingFiles,
      projectFactsStatus,
      projectFactsGeneration: facts.generation,
      projectFactsFingerprint: facts.fingerprint,
    });
  }, [projectTree.treeData.directories, projectTree.findRoot, fileActions.selectedRootDirectory, setStatusMessage]);

  const createJavaClassFromPlan = useCallback(createCreateJavaClassFromPlan({
    newJavaClassDialogState,
    applyLspWorkspaceEdit,
    setStatusMessage,
    loadDir: projectTree.treeData.loadDir,
    setSelected: uiActions.setSelected,
    openFile,
    notifyWorkspacePathGitChanged: gitSnapshotOwner.notifyWorkspacePathGitChanged,
  }), [
    applyLspWorkspaceEdit,
    projectTree.treeData.loadDir,
    newJavaClassDialogState,
    gitSnapshotOwner.notifyWorkspacePathGitChanged,
    openFile,
    uiActions.setSelected,
    setStatusMessage,
  ]);
  return {
    setAutoImportCandidatePrompt,
    setFileTemplateSettingsOpen,
    setAutoImportSettingsOpen,
    openNewJavaClassDialog,
    newJavaClassDialogState,
    setNewJavaClassDialogState,
    createJavaClassFromPlan,
    fileTemplateSettingsOpen,
    autoImportSettingsOpen,
    autoImportCandidatePrompt,
  };
}
