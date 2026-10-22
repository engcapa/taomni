import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo, CodeWorkspaceRootKind, RecentWorkspace, Tab } from "../../types";
import { type CodeWorkspaceFileContext, type CodeWorkspaceContext } from "./types";
import { clampWelcomeRecentSessionLimit } from "./preferences";
import { jsonEqual } from "./policies";

export const RECENT_WORKSPACES_KEY = "taomni.recentWorkspaces.v1";

export function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || trimmed;
}

export function workspacePathName(path: string, fallback = "Workspace"): string {
  const normalized = normalizeWorkspacePath(path);
  const parts = normalized.split("/");
  return parts[parts.length - 1] || fallback;
}

export function rootIdForPath(path: string): string {
  return `root-${hashString(normalizeWorkspacePath(path))}`;
}

export function looseIdForPath(path: string): string {
  return `loose-${hashString(normalizeWorkspacePath(path))}`;
}

export function normalizeRecentRoot(root: CodeWorkspaceRootInfo): CodeWorkspaceRootInfo | null {
  const path = normalizeWorkspacePath(root.path ?? "");
  if (!path) return null;
  const kind: CodeWorkspaceRootKind = root.kind === "folder" ? "folder" : "git";
  return {
    id: root.id?.trim() || rootIdForPath(path),
    name: root.name?.trim() || workspacePathName(path),
    path,
    kind,
  };
}

export function normalizeRecentLooseFile(file: CodeWorkspaceLooseFileInfo): CodeWorkspaceLooseFileInfo | null {
  const path = normalizeWorkspacePath(file.path ?? "");
  if (!path) return null;
  return {
    id: file.id?.trim() || looseIdForPath(path),
    name: file.name?.trim() || workspacePathName(path, "File"),
    path,
  };
}

export function normalizeRecentRoots(roots: readonly CodeWorkspaceRootInfo[] | undefined): CodeWorkspaceRootInfo[] {
  const next: CodeWorkspaceRootInfo[] = [];
  for (const root of roots ?? []) {
    const normalized = normalizeRecentRoot(root);
    if (normalized && !next.some((item) => item.path === normalized.path)) {
      next.push(normalized);
    }
  }
  return next;
}

export function normalizeRecentLooseFiles(files: readonly CodeWorkspaceLooseFileInfo[] | undefined): CodeWorkspaceLooseFileInfo[] {
  const next: CodeWorkspaceLooseFileInfo[] = [];
  for (const file of files ?? []) {
    const normalized = normalizeRecentLooseFile(file);
    if (normalized && !next.some((item) => item.path === normalized.path)) {
      next.push(normalized);
    }
  }
  return next;
}

export function normalizeRecentFileRef(
  ref: CodeWorkspaceFileRef | null | undefined,
  roots: readonly CodeWorkspaceRootInfo[],
  looseFiles: readonly CodeWorkspaceLooseFileInfo[],
): CodeWorkspaceFileRef | null {
  if (!ref) return null;
  if (ref.kind === "root") {
    const root = roots.find((item) => item.id === ref.rootId);
    if (!root) return null;
    return { kind: "root", rootId: root.id, path: ref.path };
  }
  const loose = looseFiles.find((item) => item.id === ref.id);
  if (!loose) return null;
  return { kind: "loose", id: loose.id, path: loose.path };
}

export function fileRefFromContext(file: CodeWorkspaceFileContext | null | undefined): CodeWorkspaceFileRef | null {
  if (!file) return null;
  if (file.kind === "root") {
    return { kind: "root", rootId: file.rootId, path: file.path };
  }
  return { kind: "loose", id: file.id, path: file.path };
}

export function recentWorkspaceIdFromParts(
  roots: readonly CodeWorkspaceRootInfo[],
  looseFiles: readonly CodeWorkspaceLooseFileInfo[] = [],
): string {
  const identity = JSON.stringify({
    roots: roots
      .map((root) => ({ path: normalizeWorkspacePath(root.path), kind: root.kind }))
      .sort((a, b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`)),
    looseFiles: looseFiles
      .map((file) => normalizeWorkspacePath(file.path))
      .sort((a, b) => a.localeCompare(b)),
  });
  return `workspace-${hashString(identity)}`;
}

export function newWorkspaceInstanceId(): string {
  return `workspace-instance-${crypto.randomUUID()}`;
}

export function recentWorkspaceName(
  explicitName: string | undefined,
  roots: readonly CodeWorkspaceRootInfo[],
  looseFiles: readonly CodeWorkspaceLooseFileInfo[],
): string {
  const trimmed = explicitName?.trim();
  if (trimmed) return trimmed;
  if (roots.length === 1 && looseFiles.length === 0) return roots[0].name;
  if (roots.length === 0 && looseFiles.length === 1) return looseFiles[0].name;
  if (roots.length === 0 && looseFiles.length > 0) return "Editor Workspace";
  return "Code Workspace";
}

export function recentWorkspaceFromTab(
  tab: Tab | undefined,
  context: CodeWorkspaceContext | undefined,
  now: number,
): RecentWorkspace | null {
  if (!tab?.codeWorkspace) return null;
  const contextRoots = context?.roots?.map((root) => ({
    id: root.id,
    name: root.name,
    path: root.path,
    kind: root.kind,
  }));
  let roots = normalizeRecentRoots(contextRoots ?? tab.codeWorkspace.roots);
  if (roots.length === 0 && tab.codeWorkspace.repoRoot.trim()) {
    const path = normalizeWorkspacePath(tab.codeWorkspace.repoRoot);
    roots = [{
      id: rootIdForPath(path),
      name: workspacePathName(path),
      path,
      kind: "git",
    }];
  }
  const contextLooseFiles = context?.looseFiles?.map((file) => ({
    id: file.id,
    name: file.name,
    path: file.path,
  }));
  const looseFiles = normalizeRecentLooseFiles(contextLooseFiles ?? tab.codeWorkspace.looseFiles);
  if (roots.length === 0 && looseFiles.length === 0) return null;

  const activeFile = normalizeRecentFileRef(
    fileRefFromContext(context?.activeFile) ?? tab.codeWorkspace.initialFile ?? null,
    roots,
    looseFiles,
  );
  return {
    id: recentWorkspaceIdFromParts(roots, looseFiles),
    name: recentWorkspaceName(tab.codeWorkspace.name, roots, looseFiles),
    roots,
    looseFiles,
    lastOpenedAt: now,
    lastActiveFile: activeFile,
    isGitRepo: roots.some((root) => root.kind === "git"),
  };
}

export function normalizeRecentWorkspace(workspace: RecentWorkspace): RecentWorkspace | null {
  const roots = normalizeRecentRoots(workspace.roots);
  const looseFiles = normalizeRecentLooseFiles(workspace.looseFiles);
  if (roots.length === 0 && looseFiles.length === 0) return null;
  const activeFile = normalizeRecentFileRef(workspace.lastActiveFile ?? null, roots, looseFiles);
  return {
    id: recentWorkspaceIdFromParts(roots, looseFiles),
    name: recentWorkspaceName(workspace.name, roots, looseFiles),
    roots,
    looseFiles,
    lastOpenedAt: Number.isFinite(workspace.lastOpenedAt) ? workspace.lastOpenedAt : Date.now(),
    lastActiveFile: activeFile,
    isGitRepo: workspace.isGitRepo || roots.some((root) => root.kind === "git"),
  };
}

export function upsertRecentWorkspaceList(
  current: readonly RecentWorkspace[],
  workspace: RecentWorkspace | null,
  limit: number,
): RecentWorkspace[] {
  if (!workspace) return current as RecentWorkspace[];
  const normalized = normalizeRecentWorkspace(workspace);
  if (!normalized) return current as RecentWorkspace[];
  return [
    normalized,
    ...current.filter((item) => item.id !== normalized.id),
  ]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, clampWelcomeRecentSessionLimit(limit));
}

export function codeWorkspaceInstanceId(tab: Tab | undefined): string | null {
  if (tab?.type !== "code-workspace" || !tab.codeWorkspace) return null;
  return tab.codeWorkspace.workspaceInstanceId ?? tab.id;
}

export function hasOtherWorkspaceInstanceWithRecentId(
  idsByInstance: Readonly<Record<string, string>>,
  instanceId: string,
  recentId: string,
): boolean {
  return Object.entries(idsByInstance).some(([otherInstanceId, otherRecentId]) => (
    otherInstanceId !== instanceId && otherRecentId === recentId
  ));
}

export function recentRootKey(root: CodeWorkspaceRootInfo): string {
  return `${root.kind}:${normalizeWorkspacePath(root.path)}`;
}

export function isSupersededRecentWorkspaceDefinition(
  candidate: RecentWorkspace,
  latest: RecentWorkspace,
): boolean {
  if (candidate.id === latest.id) return false;
  const candidateSize = candidate.roots.length + candidate.looseFiles.length;
  const latestSize = latest.roots.length + latest.looseFiles.length;
  if (candidateSize === 0 || candidateSize >= latestSize) return false;
  if (candidate.name !== latest.name && candidate.roots[0]?.path !== latest.roots[0]?.path) {
    return false;
  }
  const latestRoots = new Set(latest.roots.map(recentRootKey));
  const latestLooseFiles = new Set(latest.looseFiles.map((file) => normalizeWorkspacePath(file.path)));
  return (
    candidate.roots.every((root) => latestRoots.has(recentRootKey(root))) &&
    candidate.looseFiles.every((file) => latestLooseFiles.has(normalizeWorkspacePath(file.path)))
  );
}

export function upsertRecentWorkspaceForTab(
  current: readonly RecentWorkspace[],
  idsByInstance: Readonly<Record<string, string>>,
  tab: Tab | undefined,
  context: CodeWorkspaceContext | undefined,
  now: number,
  limit: number,
): {
  recentWorkspaces: RecentWorkspace[];
  recentWorkspaceIdByWorkspaceInstance: Record<string, string>;
} {
  const workspace = recentWorkspaceFromTab(tab, context, now);
  const normalized = workspace ? normalizeRecentWorkspace(workspace) : null;
  if (!normalized) {
    return {
      recentWorkspaces: current as RecentWorkspace[],
      recentWorkspaceIdByWorkspaceInstance: idsByInstance as Record<string, string>,
    };
  }

  const instanceId = codeWorkspaceInstanceId(tab);
  let base = current;
  let nextIdsByInstance = idsByInstance as Record<string, string>;
  if (instanceId) {
    const previousId = idsByInstance[instanceId] ?? tab?.codeWorkspace?.workspaceId ?? null;
    if (
      previousId &&
      previousId !== normalized.id &&
      !hasOtherWorkspaceInstanceWithRecentId(idsByInstance, instanceId, previousId)
    ) {
      base = base.filter((item) => item.id !== previousId);
    }
    if (previousId && previousId !== normalized.id) {
      base = base.filter((item) => (
        hasOtherWorkspaceInstanceWithRecentId(idsByInstance, instanceId, item.id) ||
        !isSupersededRecentWorkspaceDefinition(item, normalized)
      ));
    }
    if (idsByInstance[instanceId] !== normalized.id) {
      nextIdsByInstance = { ...idsByInstance, [instanceId]: normalized.id };
    }
  }

  return {
    recentWorkspaces: upsertRecentWorkspaceList(base, normalized, limit),
    recentWorkspaceIdByWorkspaceInstance: nextIdsByInstance,
  };
}

export function shouldRecordRecentWorkspaceContext(
  current: CodeWorkspaceContext | undefined,
  next: CodeWorkspaceContext,
): boolean {
  return (
    !current ||
    !jsonEqual(current.roots, next.roots) ||
    !jsonEqual(current.looseFiles, next.looseFiles)
  );
}

export function readRecentWorkspaces(limit: number): RecentWorkspace[] {
  try {
    const raw = window.localStorage.getItem(RECENT_WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const workspaces = parsed
      .map((item) => normalizeRecentWorkspace(item as RecentWorkspace))
      .filter((item): item is RecentWorkspace => !!item)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, clampWelcomeRecentSessionLimit(limit));
    return workspaces;
  } catch {
    return [];
  }
}

export function writeRecentWorkspaces(workspaces: readonly RecentWorkspace[]) {
  try {
    window.localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(workspaces));
  } catch {
    // Ignore storage failures; the in-memory list still works.
  }
}
