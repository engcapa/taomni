import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { workspaceDetectGitRoots, type WorkspaceGitRoot } from "../../../lib/editor/workspace";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../types";
import { errorMessage } from "./codeWorkspaceModel";

interface Options {
  roots: CodeWorkspaceRootInfo[];
  activeFile?: CodeWorkspaceFileRef | null;
  visible: boolean;
  onError: (message: string) => void;
}

const EMPTY_ROOTS: WorkspaceGitRoot[] = [];

function mergeRoots(groups: WorkspaceGitRoot[][]): WorkspaceGitRoot[] {
  const merged = new Map<string, WorkspaceGitRoot>();
  for (const group of groups) {
    for (const root of group) {
      const previous = merged.get(root.repoRoot);
      merged.set(root.repoRoot, previous
        ? { ...previous, rootIds: [...new Set([...previous.rootIds, ...root.rootIds])] }
        : root);
    }
  }
  return [...merged.values()];
}

/** Root discovery and active-file ancestor lookup have independent lifetimes.
 * Switching a file never reruns ordinary projects' nested repository scans. */
export function useWorkspaceGitRootDiscovery({ roots, activeFile, visible, onError }: Options) {
  const rootsKey = JSON.stringify(roots.map(({ id, name, path }) => ({ id, name, path })));
  const activeRoot = activeFile?.kind === "root" ? roots.find((root) => root.id === activeFile.rootId) : null;
  const activeKey = activeRoot && activeFile ? JSON.stringify([activeRoot.id, activeRoot.path, activeFile.path]) : "";
  const inputsRef = useRef({ roots, activeRoot, activeFile, onError });
  inputsRef.current = { roots, activeRoot, activeFile, onError };
  const [baseResult, setBaseResult] = useState({ key: "", roots: EMPTY_ROOTS });
  const [activeResult, setActiveResult] = useState({ key: "", roots: EMPTY_ROOTS });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const current = inputsRef.current;
    if (!visible || current.roots.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void workspaceDetectGitRoots(current.roots.map(({ id, name, path }) => ({ id, name, path })))
      .then((detected) => {
        if (cancelled) return;
        startTransition(() => setBaseResult({ key: rootsKey, roots: Array.isArray(detected) && detected.length ? detected : EMPTY_ROOTS }));
      }).catch((error) => {
        if (cancelled) return;
        setBaseResult({ key: rootsKey, roots: EMPTY_ROOTS });
        inputsRef.current.onError(errorMessage(error));
      }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rootsKey, visible]);

  useEffect(() => {
    const { activeRoot: root, activeFile: file } = inputsRef.current;
    if (!visible || !root || !file) return;
    let cancelled = false;
    // The document gets its first rendering turn before this optional Git lookup.
    const frame = window.requestAnimationFrame(() => {
      void workspaceDetectGitRoots([{
        id: root.id, name: root.name, path: root.path,
        activeFilePath: file.path, ancestorsOnly: true,
      }]).then((detected) => {
        if (cancelled) return;
        startTransition(() => setActiveResult({ key: activeKey, roots: Array.isArray(detected) && detected.length ? detected : EMPTY_ROOTS }));
      }).catch((error) => {
        if (cancelled) return;
        setActiveResult({ key: activeKey, roots: EMPTY_ROOTS });
        inputsRef.current.onError(errorMessage(error));
      });
    });
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [activeKey, rootsKey, visible]);

  const baseRoots = baseResult.key === rootsKey ? baseResult.roots : EMPTY_ROOTS;
  const activeRoots = activeResult.key === activeKey && activeKey ? activeResult.roots : EMPTY_ROOTS;
  const gitRoots = useMemo(() => mergeRoots([baseRoots, activeRoots]), [baseRoots, activeRoots]);

  return { gitRoots, gitRootsLoading: loading };
}
