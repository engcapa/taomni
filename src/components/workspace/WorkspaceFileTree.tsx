import { ChevronDown, ChevronRight, File, FilePlus2, Folder, FolderPlus, GitBranch, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { useAppDialogs } from "../../lib/appDialogs";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import {
  deleteWorkspaceEntry,
  entryName,
  joinRelativePath,
  listWorkspaceDirectory,
  renameWorkspaceEntry,
  sortEntries,
} from "./workspaceFs";
import type { PlatformWorkspace, WorkspaceRootFolder, WorkspaceTreeNode } from "../../stores/workspacePlatformStore";

interface DirectoryState {
  loading: boolean;
  entries: Array<{ name: string; path: string; kind: "file" | "folder" }>;
  error: string | null;
}

export interface WorkspaceFileTreeProps {
  workspace: PlatformWorkspace;
  createdNodes: WorkspaceTreeNode[];
  activeRootId?: string;
  activePath?: string;
  onOpenFile: (root: WorkspaceRootFolder, path: string) => void;
  onCreate: (kind: "file" | "folder", root: WorkspaceRootFolder, directory: string) => void;
  onAddRoot: () => void;
  onRemoveRoot: (rootId: string) => void;
  onOpenGitForFile: (root: WorkspaceRootFolder, path: string) => void;
  /** Bumped by the sidebar refresh button to discard cached listings. */
  refreshToken?: number;
}

function directoryKey(rootId: string, path: string): string {
  return `${rootId}:${path}`;
}

/**
 * Multi-root file tree of the Workspaces left sidebar (AC-08).
 *
 * Supports expanding several local root folders at once, creating files and
 * folders from the toolbar or a folder's context menu, adding/removing roots,
 * renaming and deleting (with confirmation) and opening files in the editor.
 */
export function WorkspaceFileTree({
  workspace,
  createdNodes,
  activeRootId,
  activePath,
  onOpenFile,
  onCreate,
  onAddRoot,
  onRemoveRoot,
  onOpenGitForFile,
  refreshToken = 0,
}: WorkspaceFileTreeProps) {
  const t = useT();
  const dialogs = useAppDialogs();
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const roots = workspace.rootFolders;
  const rootsKey = roots.map((root) => root.id).join("|");
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const rootsRef = useRef(roots);
  rootsRef.current = roots;

  useEffect(() => {
    setExpanded(new Set());
    setDirectories({});
  }, [rootsKey]);



  const loadDirectory = useCallback(async (root: WorkspaceRootFolder, path: string) => {
    const key = directoryKey(root.id, path);
    setDirectories((current) => ({
      ...current,
      [key]: { loading: true, entries: current[key]?.entries ?? [], error: null },
    }));
    const entries = await listWorkspaceDirectory(root.path, path);
    setDirectories((current) => ({
      ...current,
      [key]: {
        loading: false,
        entries: sortEntries(entries).map((entry) => ({
          name: entry.name,
          path: entry.path,
          kind: entry.fileType === "dir" ? "folder" as const : "file" as const,
        })),
        error: null,
      },
    }));
  }, []);

  // Refresh keeps the expanded set and reloads those directories so files
  // created from the toolbar (or externally) appear without collapsing the tree.
  useEffect(() => {
    if (refreshToken === 0) return;
    const keys = [...expandedRef.current];
    setDirectories({});
    for (const key of keys) {
      const divider = key.indexOf(":");
      if (divider < 0) continue;
      const rootId = key.slice(0, divider);
      const path = key.slice(divider + 1);
      const root = rootsRef.current.find((entry) => entry.id === rootId);
      if (root) void loadDirectory(root, path);
    }
  }, [loadDirectory, refreshToken]);

  const toggleRoot = (root: WorkspaceRootFolder) => {
    setSelected(directoryKey(root.id, ""));
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(directoryKey(root.id, ""))) {
        next.delete(directoryKey(root.id, ""));
      } else {
        next.add(directoryKey(root.id, ""));
        if (!directories[directoryKey(root.id, "")]) void loadDirectory(root, "");
      }
      return next;
    });
  };

  const toggleDirectory = (root: WorkspaceRootFolder, path: string) => {
    setSelected(directoryKey(root.id, path));
    setExpanded((current) => {
      const next = new Set(current);
      const key = directoryKey(root.id, path);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        if (!directories[key]) void loadDirectory(root, path);
      }
      return next;
    });
  };

  /** Created nodes that are not part of the loaded listing yet (instant feedback). */
  const extrasFor = useCallback((rootId: string, directory: string) => {
    const loaded = directories[directoryKey(rootId, directory)]?.entries ?? [];
    const known = new Set(loaded.map((entry) => entry.path));
    return createdNodes
      .filter((node) => node.rootFolderId === rootId)
      .filter((node) => (node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "") === directory)
      .filter((node) => !known.has(node.path) && node.kind === "folder")
      .map((node) => ({ name: node.name, path: node.path, kind: "folder" as const }));
  }, [createdNodes, directories]);

  const openEntryMenu = (event: React.MouseEvent, root: WorkspaceRootFolder, path: string, kind: "file" | "folder") => {
    event.preventDefault();
    event.stopPropagation();
    const fullPath = path ? `${root.path.replace(/\/+$/, "")}/${path}` : root.path;
    const items: MenuItem[] = kind === "folder"
      ? [
          { label: t("platform.newFile"), testId: "workspace-tree-new-file", onClick: () => onCreate("file", root, path) },
          { label: t("platform.newFolder"), testId: "workspace-tree-new-folder", onClick: () => onCreate("folder", root, path) },
          { label: t("platform.addRootFolder"), testId: "workspace-tree-add-root", onClick: onAddRoot },
          { label: "", separator: true, onClick: () => undefined },
          { label: t("platform.copyPath"), testId: "workspace-tree-copy-path", onClick: () => void copyPath(fullPath) },
          { label: t("platform.rename"), testId: "workspace-tree-rename", onClick: () => void rename(root, path) },
          { label: t("platform.delete"), testId: "workspace-tree-delete", danger: true, onClick: () => void remove(root, path, kind) },
          { label: "", separator: true, onClick: () => undefined },
          { label: t("platform.removeRoot"), testId: "workspace-tree-remove-root", danger: true, onClick: () => onRemoveRoot(root.id) },
        ]
      : [
          { label: t("common.open"), testId: "workspace-tree-open", onClick: () => onOpenFile(root, path) },
          { label: t("platform.openInGit"), testId: "workspace-tree-open-git", onClick: () => onOpenGitForFile(root, path) },
          { label: "", separator: true, onClick: () => undefined },
          { label: t("platform.copyPath"), testId: "workspace-tree-copy-path", onClick: () => void copyPath(fullPath) },
          { label: t("platform.rename"), testId: "workspace-tree-rename", onClick: () => void rename(root, path) },
          { label: t("platform.delete"), testId: "workspace-tree-delete", danger: true, onClick: () => void remove(root, path, kind) },
        ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const copyPath = async (fullPath: string) => {
    try {
      await navigator.clipboard.writeText(fullPath);
      setStatusMessage(`Copied ${fullPath}`);
    } catch {
      setStatusMessage(fullPath);
    }
  };

  const rename = async (root: WorkspaceRootFolder, path: string) => {
    const next = await dialogs.prompt({
      title: t("platform.rename"),
      label: t("platform.fileName"),
      initialValue: entryName(path),
    });
    if (!next?.trim()) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const target = joinRelativePath(parent, next);
    try {
      await renameWorkspaceEntry(root.path, path, target);
      setStatusMessage(`Renamed ${entryName(path)} → ${entryName(target)}`);
      if (parent) void loadDirectory(root, parent);
      else void loadDirectory(root, "");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (root: WorkspaceRootFolder, path: string, kind: "file" | "folder") => {
    const confirmed = await dialogs.confirm({
      title: t("platform.delete"),
      message: `${entryName(path)}?`,
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteWorkspaceEntry(root.path, path, kind === "folder");
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      void loadDirectory(root, parent);
      setStatusMessage(`Deleted ${entryName(path)}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const renderDirectoryChildren = (root: WorkspaceRootFolder, path: string, depth: number): React.ReactNode => {
    const key = directoryKey(root.id, path);
    const state = directories[key];
    const entries = [...(state?.entries ?? []), ...extrasFor(root.id, path)];
    const unique = new Map(entries.map((entry) => [entry.path, entry]));
    const list = [...unique.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return (
      <>
        {state?.loading && !state.entries.length && (
          <div className="px-2 py-1 text-[10.5px] text-[var(--taomni-text-muted)]" style={{ paddingLeft: 8 + depth * 13 }}>
            Loading…
          </div>
        )}
        {state?.error && (
          <div className="px-2 py-1 text-[10.5px] text-[var(--taomni-danger)]" style={{ paddingLeft: 8 + depth * 13 }}>
            {state.error}
          </div>
        )}
        {list.map((entry) => {
          const isFolder = entry.kind === "folder";
          const entryKey = directoryKey(root.id, entry.path);
          const isExpanded = isFolder && expanded.has(entryKey);
          const isActive = !isFolder && activePath === entry.path && activeRootId === root.id;
          return (
            <div key={`${root.id}:${entry.path}`}>
              <div
                role="treeitem"
                tabIndex={0}
                aria-expanded={isFolder ? isExpanded : undefined}
                aria-selected={isActive || selected === entryKey}
                data-testid={isFolder ? "workspace-tree-folder" : "workspace-tree-file"}
                data-path={entry.path}
                data-root-id={root.id}
                data-active={isActive || undefined}
                className="group flex h-[22px] cursor-pointer items-center gap-1 rounded pr-1 hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-selected)]"
                style={{ paddingLeft: 6 + depth * 13 }}
                onClick={() => {
                  setSelected(entryKey);
                  if (isFolder) toggleDirectory(root, entry.path);
                  else onOpenFile(root, entry.path);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    if (isFolder) toggleDirectory(root, entry.path);
                    else onOpenFile(root, entry.path);
                  }
                }}
                onContextMenu={(event) => openEntryMenu(event, root, entry.path, entry.kind)}
              >
                {isFolder ? (
                  isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />
                ) : <span className="w-3 shrink-0" />}
                {isFolder
                  ? <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--taomni-accent)" }} />
                  : <File className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-text-muted)]" />}
                <span className="truncate" style={{ fontSize: "var(--taomni-ui-font-size)" }}>{entry.name}</span>
              </div>
              {isFolder && isExpanded && renderDirectoryChildren(root, entry.path, depth + 1)}
            </div>
          );
        })}
      </>
    );
  };

  const rootList = useMemo(() => roots, [roots]);

  return (
    <div data-testid="workspace-file-tree" role="tree" aria-label="Workspace files" className="min-h-0 flex-1 overflow-auto py-1">
      {rootList.length === 0 && (
        <div className="px-2 py-2 text-[11px] text-[var(--taomni-text-muted)]" data-testid="workspace-file-tree-empty">
          {t("platform.noWorkspaceRoot")}
        </div>
      )}
      {rootList.map((root) => {
        const isExpanded = expanded.has(directoryKey(root.id, ""));
        return (
          <div key={root.id}>
            <div
              role="treeitem"
              tabIndex={0}
              aria-expanded={isExpanded}
              data-testid="workspace-tree-root"
              data-root-id={root.id}
              data-path={root.path}
              className="flex h-[24px] cursor-pointer items-center gap-1 rounded pr-1 hover:bg-[var(--taomni-hover)]"
              style={{ paddingLeft: 4 }}
              onClick={() => toggleRoot(root)}
              onContextMenu={(event) => openEntryMenu(event, root, "", "folder")}
            >
              {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--taomni-warning, #d97706)" }} />
              <span className="truncate font-semibold" style={{ fontSize: "var(--taomni-ui-font-size)" }}>{root.name}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                <button
                  type="button"
                  data-testid="workspace-tree-root-new-file"
                  title={t("platform.newFile")}
                  className="rounded p-0.5 hover:bg-[var(--taomni-hover)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCreate("file", root, "");
                  }}
                >
                  <FilePlus2 className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  data-testid="workspace-tree-root-new-folder"
                  title={t("platform.newFolder")}
                  className="rounded p-0.5 hover:bg-[var(--taomni-hover)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCreate("folder", root, "");
                  }}
                >
                  <FolderPlus className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  data-testid="workspace-tree-root-remove"
                  title={t("platform.removeRoot")}
                  className="rounded p-0.5 hover:bg-[var(--taomni-hover)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveRoot(root.id);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  data-testid="workspace-tree-root-refresh"
                  title={t("platform.refreshTree")}
                  className="rounded p-0.5 hover:bg-[var(--taomni-hover)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    void loadDirectory(root, "");
                  }}
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  data-testid="workspace-tree-root-git"
                  title={t("platform.openGitPanel")}
                  className="rounded p-0.5 hover:bg-[var(--taomni-hover)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenGitForFile(root, "");
                  }}
                >
                  <GitBranch className="h-3 w-3" />
                </button>
              </span>
            </div>
            {isExpanded && renderDirectoryChildren(root, "", 1)}
          </div>
        );
      })}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
