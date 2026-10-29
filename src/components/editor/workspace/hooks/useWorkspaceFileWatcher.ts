import { useEffect } from "react";
import { lspStartWorkspaceWatcher, lspStopWorkspaceWatcher } from "../../../../lib/editor/lsp";
import { isTauriRuntime } from "../../../../lib/runtime";
import type { CodeWorkspaceInstanceUi } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { errorMessage, normalizeFsPath } from "../codeWorkspaceModel";

interface Dependencies {
  roots: CodeWorkspaceRootInfo[];
  looseFiles: CodeWorkspaceLooseFileInfo[];
  workspaceUi: Pick<CodeWorkspaceInstanceUi, "openFiles" | "expandedDirKeys">;
  workspaceInstanceId: string;
  setStatusMessage: (message: string) => void;
}

const join = (root: string, path: string) => normalizeFsPath(`${root.replace(/[/\\]+$/, "")}/${path}`);

/** Visible directories and open files supplement nonrecursive home-root watching. */
export function useWorkspaceFileWatcher({ roots, looseFiles, workspaceUi, workspaceInstanceId, setStatusMessage }: Dependencies) {
  const paths = new Set([...roots.map((root) => root.path), ...looseFiles.map((file) => file.path)]);
  for (const file of Object.values(workspaceUi.openFiles)) {
    if (file.library) continue;
    const ref = file.ref;
    if (ref.kind === "loose") paths.add(ref.path);
    else {
      const root = roots.find((root) => root.id === ref.rootId);
      if (root) paths.add(join(root.path, ref.path));
    }
  }
  const directories = new Set<string>();
  for (const root of roots) {
    const prefix = `${root.id}:`;
    for (const key of workspaceUi.expandedDirKeys) {
      if (key.startsWith(prefix)) directories.add(join(root.path, key.slice(prefix.length)));
    }
  }
  // Buffer text/loading/caret changes do not replace a watcher with identical
  // paths. OS registration follows only filesystem ownership and expansion.
  const plan = JSON.stringify({ roots: [...paths].sort(), directories: [...directories].sort() });
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    const paths = JSON.parse(plan) as { roots: string[]; directories: string[] };
    let disposed = false;
    void lspStartWorkspaceWatcher(workspaceInstanceId, paths.roots, paths.directories).catch((error) => {
      if (!disposed) setStatusMessage(`File watcher unavailable: ${errorMessage(error)}`);
    });
    return () => {
      disposed = true;
      void lspStopWorkspaceWatcher(workspaceInstanceId).catch(() => undefined);
    };
  }, [plan, setStatusMessage, workspaceInstanceId]);
}
