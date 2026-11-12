import { useCallback, useEffect, useRef, type RefObject } from "react";
import { workspaceImportPaths } from "../../../../lib/editor/workspace/importing";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { absoluteWorkspacePath, errorMessage, rootDirKey } from "../codeWorkspaceModel";
import type { ImportDroppedPaths } from "../useProjectTreeFileDrop";

type SetExpansion = (update: (current: Set<string>) => Set<string>) => void;
interface Dependencies {
  workspaceId: string;
  rootsRef: RefObject<CodeWorkspaceRootInfo[]>;
  setExpandedRoots: SetExpansion;
  setExpandedDirs: SetExpansion;
  loadDir: (rootId: string, path: string) => Promise<void>;
  loadFlatFiles: (rootId: string, force?: boolean) => Promise<void>;
  refreshPath: (absolutePath: string) => void;
  notifyGitChanged: (rootId: string, path: string) => void;
  onStatus: (message: string) => void;
}

/** Request ownership is independent of a row. Native copy keeps its captured
 * destination even after unmount; stale completion cannot mutate the new UI. */
export function useWorkspaceDropImport(dependencies: Dependencies): ImportDroppedPaths {
  const latest = useRef(dependencies);
  latest.current = dependencies;
  const owner = useRef<object | null>(null);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    owner.current = {};
    return () => { owner.current = null; };
  }, [dependencies.workspaceId]);

  return useCallback(async (target, paths) => {
    const context = latest.current;
    const root = context.rootsRef.current.find((entry) => entry.id === target.rootId);
    const requestOwner = owner.current;
    if (!root || !requestOwner || !paths.length) return;
    const key = JSON.stringify([context.workspaceId, root.id, root.path, target.path, [...paths].sort()]);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    const currentContext = () => owner.current === requestOwner
      && latest.current.workspaceId === context.workspaceId
      && latest.current.rootsRef.current.some((entry) => entry.id === root.id && entry.path === root.path)
      ? latest.current : null;
    context.onStatus(`Importing ${paths.length} item(s) into ${root.name} / ${target.path || "."}…`);
    try {
      const result = await workspaceImportPaths(root.path, target.path, paths);
      const current = currentContext();
      if (!current) return;
      if (result.imported.length) {
        current.setExpandedRoots((expanded) => new Set(expanded).add(root.id));
        current.setExpandedDirs((expanded) => {
          const next = new Set(expanded);
          let path = "";
          for (const part of target.path.split("/").filter(Boolean)) {
            path = path ? `${path}/${part}` : part;
            next.add(rootDirKey(root.id, path));
          }
          return next;
        });
        for (const entry of result.imported) {
          current.refreshPath(absoluteWorkspacePath(root, entry.path));
          current.notifyGitChanged(root.id, entry.path);
        }
        await Promise.all([
          current.loadDir(root.id, target.path),
          current.loadFlatFiles(root.id, true),
        ]);
      }
      const final = currentContext();
      if (!final) return;
      const summary = `Imported ${result.imported.length} item(s) into ${root.name} / ${target.path || "."}`;
      final.onStatus(result.failures.length
        ? `${summary}; ${result.failures.length} failed: ${result.failures.map((failure) => `${failure.sourcePath}: ${failure.message}`).join("; ")}`
        : summary);
    } catch (error) {
      currentContext()?.onStatus(`Import failed: ${errorMessage(error)}`);
    } finally {
      pending.current.delete(key);
    }
  }, []);
}
