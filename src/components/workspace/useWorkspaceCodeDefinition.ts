import { useEffect, useMemo, useRef } from "react";
import { workspaceEditorInstanceId } from "../../lib/workspaceRuntimeIdentity";
import { useAppStore } from "../../stores/appStore";
import { fileRefFromContext, recentWorkspaceFromTab } from "../../stores/app/recentWorkspaces";
import { useWorkspacePlatformStore, type PlatformWorkspace } from "../../stores/workspacePlatformStore";
import type { CodeWorkspaceTabInfo } from "../../types";

/** Separate external editor inputs from its own persisted active-file output. */
export function useWorkspaceCodeDefinition(workspace: PlatformWorkspace, tabId: string): CodeWorkspaceTabInfo {
  const context = useAppStore((state) => state.codeWorkspaceByTab[tabId]);
  const published = useRef<CodeWorkspaceTabInfo | null>(null);
  const input = useRef<CodeWorkspaceTabInfo | null>(null);
  const info = useMemo<CodeWorkspaceTabInfo>(() => {
    const next: CodeWorkspaceTabInfo = {
      ...workspace.codeWorkspace,
      repoRoot: workspace.rootFolders[0]?.path ?? "",
      workspaceId: workspace.codeWorkspace?.workspaceId ?? workspace.id,
      workspaceInstanceId: workspaceEditorInstanceId(workspace),
      name: workspace.name,
      roots: workspace.rootFolders.map((root) => ({
        id: root.id, name: root.name, path: root.path,
        kind: workspace.codeWorkspace?.roots?.find((candidate) => candidate.id === root.id)?.kind ?? "folder",
      })),
      looseFiles: workspace.codeWorkspace?.looseFiles ?? [],
    };
    // The exact object records provenance: external callers still supply new
    // targets, even while an earlier editor publication is being persisted.
    if (input.current && workspace.codeWorkspace === published.current) {
      next.initialFile = input.current.initialFile;
    }
    if (!input.current || JSON.stringify(input.current) !== JSON.stringify(next)) input.current = next;
    return input.current;
  }, [workspace.codeWorkspace, workspace.id, workspace.name, workspace.rootFolders]);
  const infoRef = useRef(info);
  infoRef.current = info;
  const hadActiveFile = useRef(false);

  useEffect(() => {
    if (!context) return;
    const current = infoRef.current;
    if (context.activeFile) hadActiveFile.current = true;
    const next: CodeWorkspaceTabInfo = {
      ...current,
      repoRoot: context.repoRoot,
      roots: context.roots ?? current.roots,
      looseFiles: context.looseFiles ?? current.looseFiles,
      initialFile: hadActiveFile.current ? fileRefFromContext(context.activeFile) : current.initialFile,
    };
    published.current = next;
    useWorkspacePlatformStore.getState().updateCodeWorkspace(workspace.id, next);
    const recent = recentWorkspaceFromTab({ id: tabId, type: "code-workspace", title: workspace.name, closable: true, codeWorkspace: next }, context, Date.now());
    if (recent) useAppStore.getState().upsertRecentWorkspace(recent);
    // A changed input must not republish the editor's previous context while
    // that input is being applied. Its next publication owns the result.
  }, [context, tabId, workspace.id, workspace.name]);

  return info;
}
