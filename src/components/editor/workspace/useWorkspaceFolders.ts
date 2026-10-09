import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import type { CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo, CodeWorkspaceTabInfo } from "../../../types";
import { initialLooseFiles, initialRoots } from "./codeWorkspaceModel";

/** Files and Git share canonical folders; legacy editors retain local ownership. */
export function useWorkspaceFolders(workspace: CodeWorkspaceTabInfo) {
  const owner = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === workspace.workspaceId));
  const [roots, updateRoots] = useState(() => owner?.roots ?? initialRoots(workspace));
  const [looseFiles, updateLooseFiles] = useState(() => owner?.looseFiles ?? initialLooseFiles(workspace));
  const local = useRef({ roots, looseFiles });
  const pending = useRef(0);
  const ownerId = workspace.workspaceId;
  const sync = useCallback(() => {
    if (pending.current) return;
    const current = useWorkspaceStore.getState().workspaces.find((item) => item.id === ownerId);
    if (!current) return;
    local.current = { roots: current.roots, looseFiles: current.looseFiles };
    updateRoots(current.roots);
    updateLooseFiles(current.looseFiles);
  }, [ownerId]);
  useEffect(sync, [owner?.roots, owner?.looseFiles, sync]);
  const persist = useCallback((patch: { roots?: CodeWorkspaceRootInfo[]; looseFiles?: CodeWorkspaceLooseFileInfo[] }) => {
    if (!ownerId || !useWorkspaceStore.getState().workspaces.some((item) => item.id === ownerId)) return;
    pending.current++;
    void useWorkspaceStore.getState().patch(ownerId, patch).catch(() => {}).finally(() => {
      pending.current--;
      sync();
    });
  }, [ownerId, sync]);
  const setRoots = useCallback((updater: SetStateAction<CodeWorkspaceRootInfo[]>) => {
    const next = typeof updater === "function" ? updater(local.current.roots) : updater;
    local.current.roots = next;
    updateRoots(next);
    persist({ roots: next });
  }, [persist]);
  const setLooseFiles = useCallback((updater: SetStateAction<CodeWorkspaceLooseFileInfo[]>) => {
    const next = typeof updater === "function" ? updater(local.current.looseFiles) : updater;
    local.current.looseFiles = next;
    updateLooseFiles(next);
    persist({ looseFiles: next });
  }, [persist]);
  return { roots, setRoots, looseFiles, setLooseFiles };
}
