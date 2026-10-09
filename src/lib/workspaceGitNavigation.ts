import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../types";
import { useAppStore } from "../stores/appStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

function normalize(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function workspaceFileForGitPath(roots: CodeWorkspaceRootInfo[], repoRoot: string, path: string): CodeWorkspaceFileRef | null {
  const absolute = `${normalize(repoRoot)}/${path.replace(/\\/g, "/")}`;
  if (path.split(/[\\/]/).includes("..")) return null;
  const key = (value: string) => /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
  const root = [...roots].sort((a, b) => b.path.length - a.path.length).find((candidate) => (
    key(absolute).startsWith(`${key(normalize(candidate.path))}/`)
  ));
  return root ? { kind: "root", rootId: root.id, path: absolute.slice(normalize(root.path).length + 1) } : null;
}

/** Reuse the owning Files surface, including its unsaved buffers and history. */
export function openWorkspaceFileFromGit(workspaceId: string, repoRoot: string, path?: string | null): boolean {
  const state = useWorkspaceStore.getState();
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return false;
  const file = path ? workspaceFileForGitPath(workspace.roots, repoRoot, path) : null;
  if (path && !file) {
    useAppStore.getState().setStatusMessage("This file is outside the workspace folders");
    return true;
  }
  const app = useAppStore.getState();
  const existing = app.tabs.find((tab) => tab.type === "code-workspace" && tab.codeWorkspace?.workspaceId === workspaceId);
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
  state.selectView("files");
  const request = { id: crypto.randomUUID(), file };
  if (existing) {
    useAppStore.setState((current) => ({ tabs: current.tabs.map((tab) => tab.id === existing.id
      ? { ...tab, codeWorkspace: { ...tab.codeWorkspace!, openFileRequest: request } } : tab) }));
    app.setActiveTab(existing.id);
  } else {
    const id = crypto.randomUUID();
    app.addTab({ id, type: "code-workspace", title: workspace.name, closable: true,
      surface: { scope: "workspace", kind: "files", surfaceId: id, workspaceId },
      codeWorkspace: { repoRoot: workspace.roots[0]?.path ?? "", workspaceId, workspaceInstanceId: workspaceId,
        name: workspace.name, roots: workspace.roots, looseFiles: workspace.looseFiles, initialFile: file } });
  }
  return true;
}
