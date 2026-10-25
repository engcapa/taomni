import { useAppStore } from "../stores/appStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../stores/workspacePlatformStore";
import { newWorkspaceInstanceId, recentWorkspaceIdFromParts, rootIdForPath, workspacePathName } from "../stores/app/recentWorkspaces";
import type { CodeWorkspaceTabInfo } from "../types";

/** All editor entry points belong to Workspaces, including restored Sessions tabs. */
export function openPlatformCodeWorkspace(info: CodeWorkspaceTabInfo): string {
  const store = useWorkspacePlatformStore.getState();
  const roots = info.roots?.length ? info.roots : info.repoRoot.trim() ? [{
    id: rootIdForPath(info.repoRoot), name: workspacePathName(info.repoRoot), path: info.repoRoot, kind: "git" as const,
  }] : [];
  const looseFiles = info.looseFiles ?? [];
  const hasProject = roots.length > 0 || looseFiles.length > 0;
  const identity = recentWorkspaceIdFromParts(roots, looseFiles);
  const projectKey = (items: typeof roots, files: typeof looseFiles) =>
    recentWorkspaceIdFromParts(items.map((root) => ({ ...root, kind: "folder" })), files);
  let workspace = hasProject ? store.workspaces.find((candidate) => {
    const definition = candidate.codeWorkspace;
    const candidateRoots = definition?.roots ?? candidate.rootFolders.map((root) => ({ ...root, kind: "folder" as const }));
    return projectKey(candidateRoots, definition?.looseFiles ?? []) === projectKey(roots, looseFiles);
  }) : store.getWorkspace(DEFAULT_WORKSPACE_ID);
  if (!workspace) {
    workspace = store.createWorkspace({
      name: info.name?.trim() || roots[0]?.name || "Editor Workspace",
      codeWorkspace: {
        ...info,
        workspaceId: info.workspaceId ?? identity,
        workspaceInstanceId: info.workspaceInstanceId ?? (identity || newWorkspaceInstanceId()),
        roots,
        looseFiles,
      },
    });
  } else if (hasProject && !workspace.codeWorkspace) {
    const existingFolders = workspace.rootFolders;
    const mappedRoots = roots.map((root) => ({
      ...root, id: existingFolders.find((folder) => folder.path === root.path)?.id ?? root.id,
    }));
    store.updateCodeWorkspace(workspace.id, {
      ...info, roots: mappedRoots, looseFiles,
      workspaceInstanceId: info.workspaceInstanceId ?? identity,
      initialFile: info.initialFile?.kind === "root" ? {
        ...info.initialFile,
        rootId: mappedRoots[roots.findIndex((root) => info.initialFile?.kind === "root" && root.id === info.initialFile.rootId)]?.id ?? info.initialFile.rootId,
      } : info.initialFile,
    });
  } else if (info.initialFile && workspace.codeWorkspace) {
    // Git/Open File can target another file in an already running editor.
    // Keep its root IDs and recovery identity while revealing the requested file.
    const target = info.initialFile;
    const sourceRoot = target.kind === "root" ? roots.find((root) => root.id === target.rootId) : undefined;
    const targetRoot = sourceRoot && workspace.rootFolders.find((root) => root.path === sourceRoot.path);
    store.updateCodeWorkspace(workspace.id, {
      ...workspace.codeWorkspace,
      initialFile: target.kind === "root" && targetRoot ? { ...target, rootId: targetRoot.id } : target,
    });
  }
  store.setActiveWorkspace(workspace.id);
  store.openCodeWorkspaceTab(workspace.id);
  const app = useAppStore.getState();
  app.setActiveSideTab("workspaces");
  app.setSidebarCollapsed(!hasProject);
  return workspace.id;
}
