import { useEffect } from "react";
import { useAppStore } from "../../../../stores/appStore";
import type { CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import { type CodeWorkspaceGitManagerPayload } from "../controller/model";
import { useWorkspaceInspections } from "./useWorkspaceInspections";


export interface UseWorkspaceContextPublicationContext {
  onSyncGitManager: ((payload: CodeWorkspaceGitManagerPayload) => void) | undefined;
  gitManagerPayload: CodeWorkspaceGitManagerPayload;
  roots: CodeWorkspaceRootInfo[];
  openOrder: string[];
  deferredOpenFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  looseFiles: CodeWorkspaceLooseFileInfo[];
  inspections: ReturnType<typeof useWorkspaceInspections>;
  lspFiles: Record<string, LspFileState>;
  activeLspState: LspFileState | null;
  tabId: string;
  workspace: import("../../../../types").CodeWorkspaceTabInfo;
  deferredActiveFile: import("../editorGroupTypes").OpenFileViewModel | null;
  dirtyFiles: import("../editorGroupTypes").OpenFileViewModel[];
}

export function useWorkspaceContextPublication(context: UseWorkspaceContextPublicationContext) {
  const {
    onSyncGitManager,
    gitManagerPayload,
    roots,
    openOrder,
    deferredOpenFiles,
    looseFiles,
    inspections,
    lspFiles,
    activeLspState,
    tabId,
    workspace,
    deferredActiveFile,
    dirtyFiles,
  } = context;
  const setTabCodeWorkspaceContext = useAppStore((s) => s.setTabCodeWorkspaceContext);

  useEffect(() => {
    if (!onSyncGitManager) return;
    onSyncGitManager(gitManagerPayload);
  }, [gitManagerPayload, onSyncGitManager]);

  useEffect(() => {
    const firstRoot = roots[0] ?? null;
    const openStates = openOrder.map((key) => deferredOpenFiles[key]).filter((file): file is OpenFileState => !!file);
    const toContextFile = (file: OpenFileState) => {
      const ref = file.ref;
      if (ref.kind === "root") {
        const root = roots.find((item) => item.id === ref.rootId);
        return {
          kind: "root" as const,
          rootId: ref.rootId,
          rootName: root?.name,
          rootPath: root?.path,
          path: ref.path,
        };
      }
      const loose = looseFiles.find((item) => item.id === ref.id);
      return {
        kind: "loose" as const,
        id: ref.id,
        name: loose?.name,
        path: ref.path,
      };
    };
    const lspDiagnostics = openStates
      .map((file) => {
        const diagnostics = inspections.displayDiagnosticsFor(
          lspFiles[file.key]?.diagnostics,
          inspections.inspectionPathForFileKey(file.key),
        );
        if (diagnostics.length === 0) return null;
        return {
          file: toContextFile(file),
          errorCount: diagnostics.filter((item) => item.severity === 1).length,
          warningCount: diagnostics.filter((item) => item.severity === 2).length,
          infoCount: diagnostics.filter((item) => item.severity !== 1 && item.severity !== 2).length,
          messages: diagnostics
            .slice()
            .sort((a, b) => (a.severity ?? 99) - (b.severity ?? 99))
            .slice(0, 5)
            .map((item) => item.message),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item);
    const activeStatus = activeLspState?.status
      ? {
        displayName: activeLspState.status.displayName,
        languageId: activeLspState.status.languageId,
        active: activeLspState.status.active,
        available: activeLspState.status.available,
        selectedCommand: activeLspState.status.selectedCommand,
        installHint: activeLspState.status.installHint,
        error: activeLspState.status.error ?? activeLspState.error,
      }
      : null;
    const lspContext = activeStatus || lspDiagnostics.length > 0
      ? {
        activeStatus,
        diagnostics: lspDiagnostics,
      }
      : null;
    setTabCodeWorkspaceContext(tabId, {
      repoRoot: firstRoot?.path ?? workspace.repoRoot ?? "",
      activePath: deferredActiveFile?.ref.kind === "root" && deferredActiveFile.ref.rootId === firstRoot?.id ? deferredActiveFile.ref.path : null,
      openPaths: firstRoot ? openStates.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      dirtyPaths: firstRoot ? dirtyFiles.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      roots,
      looseFiles,
      activeFile: deferredActiveFile ? toContextFile(deferredActiveFile) : null,
      openFiles: openStates.map(toContextFile),
      dirtyFiles: dirtyFiles.map(toContextFile),
      lsp: lspContext,
    });
  }, [
    activeLspState,
    deferredActiveFile,
    deferredOpenFiles,
    dirtyFiles,
    inspections.displayDiagnosticsFor,
    inspections.inspectionPathForFileKey,
    looseFiles,
    lspFiles,
    openOrder,
    roots,
    setTabCodeWorkspaceContext,
    tabId,
    workspace.repoRoot,
  ]);

  useEffect(() => {
    return () => setTabCodeWorkspaceContext(tabId, null);
  }, [setTabCodeWorkspaceContext, tabId]);
  return {};
}
