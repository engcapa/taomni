import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitBlameLines, gitBlobPair, type GitBlameLine, type GitChange } from "../../../../lib/git";
import { type LspPosition } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type CodeWorkspaceEditorGroupState, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { getAllLeafNodes } from "../recursiveLayoutTree";
import { type WorkspaceIntelligencePreferences } from "../intelligencePreferences";
import { isLargeFileContent } from "../largeFile";
import { useDeferredGitLineChanges } from "../useDeferredGitLineChanges";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, gitRootForWorkspacePath, gitPathForWorkspacePath, gitRootsForWorkspaceRoot, workspacePathForGitPath } from "../codeWorkspaceModel";

export interface UseWorkspaceGitDecorationsContext {
  roots: CodeWorkspaceRootInfo[];
  gitRoots: import("../../../../lib/editor/workspace").WorkspaceGitRoot[];
  gitSnapshots: Record<string, import("../codeWorkspaceModel").WorkspaceGitSnapshotState>;
  workspaceUi: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi;
  editorGroups: Record<string, CodeWorkspaceEditorGroupState>;
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  intelligencePreferences: WorkspaceIntelligencePreferences;
  cursorPositions: Record<string, LspPosition>;
  workspaceInstanceId: string;
}

export function useWorkspaceGitDecorations(context: UseWorkspaceGitDecorationsContext) {
  const {
    roots,
    gitRoots,
    gitSnapshots,
    workspaceUi,
    editorGroups,
    openFiles,
    openFilesRef,
    intelligencePreferences,
    cursorPositions,
    workspaceInstanceId,
  } = context;
  const [gitHeadTextByFile, setGitHeadTextByFile] = useState<Record<string, { sourceKey: string; text: string | null }>>({});
  const [gitBlameByGroup, setGitBlameByGroup] = useState<Record<EditorGroupId, GitBlameLine | null>>({
      primary: null,
      secondary: null,
    });
  const gitHeadRequestsRef = useRef(new Set<string>());
  const gitBlameCacheRef = useRef(new Map<string, GitBlameLine | null>());

  const gitChangeByRootPath = useMemo(() => {
    const map = new Map<string, GitChange>();
    for (const root of roots) {
      for (const repo of gitRootsForWorkspaceRoot(root, gitRoots)) {
        const snapshot = gitSnapshots[repo.repoRoot];
        if (!snapshot?.changes.length) continue;
        for (const change of snapshot.changes) {
          const workspacePath = workspacePathForGitPath(root, repo, change.path);
          if (workspacePath === null) continue;
          map.set(`${root.id}:${workspacePath}`, change);
        }
      }
    }
    return map;
  }, [gitRoots, gitSnapshots, roots]);

  const gitTargetForFile = useCallback((file: OpenFileState | null) => {
    // A root reference is enough to prefetch the immutable HEAD blob while
    // the working-tree buffer is loading. Buffer-dependent consumers still
    // gate on `file.loading` before they render or query.
    if (!file || file.ref.kind !== "root") return null;
    const ref = file.ref;
    const root = roots.find((candidate) => candidate.id === ref.rootId);
    if (!root) return null;
    const repo = gitRootForWorkspacePath(root, ref.path, gitRoots);
    if (!repo) return null;
    const path = gitPathForWorkspacePath(root, repo, ref.path);
    if (!path) return null;
    const snapshot = gitSnapshots[repo.repoRoot];
    return {
      repoRoot: repo.repoRoot,
      path,
      headOid: snapshot?.headOid ?? null,
      sourceKey: `${repo.repoRoot}:${snapshot?.headOid ?? "no-head"}:${path}`,
    };
  }, [gitRoots, gitSnapshots, roots]);

  // §8.17.4 step 1: every chrome consumer derives its per-leaf inputs from
  // the recursive tree's leaves — no `editorGroups.primary/secondary` enum and
  // no two-group swap fallback. A third split leaf gets the same treatment.
  const layoutLeafActiveEntries = useMemo(
    () => getAllLeafNodes(workspaceUi.layoutTreeV2).map((leaf) => ({
      groupId: leaf.id as EditorGroupId,
      activeKey: (editorGroups[leaf.id]?.activeKey ?? leaf.activeKey ?? null) as string | null,
    })),
    [editorGroups, workspaceUi.layoutTreeV2],
  );

  const activeGitFileStateSignature = useMemo(() => {
    const stateForKey = (key: string | null) => {
      if (!key) return "empty";
      const file = openFiles[key];
      if (!file) return "missing";
      if (file.loading) return "loading";
      return `${file.documentRevision ?? 0}:${isLargeFileContent(file.text) ? "large" : "ready"}`;
    };
    return layoutLeafActiveEntries
      .map(({ groupId, activeKey }) => `${groupId}:${activeKey ?? "empty"}:${stateForKey(activeKey)}`)
      .join("|");
  }, [layoutLeafActiveEntries, openFiles]);

  const gitDiffSources = useMemo(() => {
    const seen = new Set<string>();
    return layoutLeafActiveEntries.flatMap(({ activeKey }) => {
      if (!activeKey || seen.has(activeKey)) return [];
      seen.add(activeKey);
      const file = openFiles[activeKey];
      const target = gitTargetForFile(file ?? null);
      const head = gitHeadTextByFile[activeKey];
      const largeFile = file ? isLargeFileContent(file.text) : false;
      // A repository without a HEAD cannot have a comparable line diff. Keep
      // the hook idle until the snapshot exposes a real HEAD and its blob is
      // read, avoiding a throwaway debounce during Git discovery.
      if (!file || file.loading || largeFile || !target?.headOid || !head || head.sourceKey !== target.sourceKey) return [];
      return [{
        key: activeKey,
        filePath: `${target.repoRoot}/${target.path}`,
        sourceKey: target.sourceKey,
        headOid: target.headOid,
        textVersion: file.documentRevision ?? 0,
        headText: head.text,
        bufferText: file.text,
        largeFile,
      }];
    });
  }, [
    gitHeadTextByFile,
    gitTargetForFile,
    layoutLeafActiveEntries,
    openFiles,
  ]);
  const gitLineChangesByFile = useDeferredGitLineChanges(gitDiffSources);

  useEffect(() => {
    let cancelled = false;
    const activeKeys = new Set(layoutLeafActiveEntries
      .map(({ activeKey }) => activeKey)
      .filter((key): key is string => !!key));
    for (const key of activeKeys) {
      const file = openFilesRef.current[key];
      const target = gitTargetForFile(file ?? null);
      if (!file || file.loading || isLargeFileContent(file.text) || !target || gitHeadTextByFile[key]?.sourceKey === target.sourceKey) continue;
      if (!target.headOid) {
        setGitHeadTextByFile((current) => ({
          ...current,
          [key]: { sourceKey: target.sourceKey, text: "" },
        }));
        continue;
      }
      if (gitHeadRequestsRef.current.has(target.sourceKey)) continue;
      gitHeadRequestsRef.current.add(target.sourceKey);
      void gitBlobPair(target.repoRoot, target.path, "HEAD", "")
        .then((pair) => {
          if (cancelled) return;
          setGitHeadTextByFile((current) => ({
            ...current,
            [key]: {
              sourceKey: target.sourceKey,
              text: pair.binary || pair.oversize ? null : pair.oldText ?? "",
            },
          }));
        })
        .catch(() => {
          if (!cancelled) {
            setGitHeadTextByFile((current) => ({
              ...current,
              [key]: { sourceKey: target.sourceKey, text: null },
            }));
          }
        })
        .finally(() => gitHeadRequestsRef.current.delete(target.sourceKey));
    }
    return () => { cancelled = true; };
  }, [activeGitFileStateSignature, gitTargetForFile]);

  const gitBlameRequestSignature = useMemo(() => (
    layoutLeafActiveEntries.map(({ groupId, activeKey }) => {
      const key = activeKey;
      // Input batching keeps the store snapshot stable during a typing burst,
      // but the ref is updated immediately.  Use it here so inline blame is
      // disabled from the first dirty keystroke rather than one batch later.
      const file = key ? openFilesRef.current[key] ?? null : null;
      const target = gitTargetForFile(file);
      if (!intelligencePreferences.inlineBlameEnabled || !file || file.loading || file.dirty || !target?.headOid) {
        return `${groupId}:${key ?? "empty"}:disabled`;
      }
      const line = (cursorPositions[groupId]?.line ?? 0) + 1;
      return `${groupId}:${key}:${target.sourceKey}:${file.hash}:${line}`;
    }).join("|")
  ), [
    cursorPositions,
    gitTargetForFile,
    intelligencePreferences.inlineBlameEnabled,
    layoutLeafActiveEntries,
    openFilesRef,
  ]);

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const cacheBlame = (cacheKey: string, blame: GitBlameLine | null) => {
      const cache = gitBlameCacheRef.current;
      cache.delete(cacheKey);
      cache.set(cacheKey, blame);
      if (cache.size > 256) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
    };
    const leafGroupIds: EditorGroupId[] = (() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      return getAllLeafNodes(ui.layoutTreeV2).map((leaf) => leaf.id);
    })();
    const loadForGroup = (groupId: EditorGroupId) => {
      const groupState = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId)
        .editorGroups[groupId];
      const key = groupState?.activeKey ?? null;
      const file = key ? openFilesRef.current[key] ?? null : null;
      const target = gitTargetForFile(file);
      if (!intelligencePreferences.inlineBlameEnabled || !file || file.loading || file.dirty || !target?.headOid) {
        setGitBlameByGroup((current) => current[groupId] === null ? current : { ...current, [groupId]: null });
        return;
      }
      const line = (cursorPositions[groupId]?.line ?? 0) + 1;
      const cacheKey = `${target.sourceKey}:${file.hash}:${line}`;
      if (gitBlameCacheRef.current.has(cacheKey)) {
        const cached = gitBlameCacheRef.current.get(cacheKey) ?? null;
        cacheBlame(cacheKey, cached);
        setGitBlameByGroup((current) => current[groupId] === cached ? current : { ...current, [groupId]: cached });
        return;
      }
      timers.push(window.setTimeout(() => {
        void gitBlameLines(target.repoRoot, target.path, line, line)
          .then((lines) => {
            const blame = lines[0] ?? null;
            cacheBlame(cacheKey, blame);
            if (!cancelled) setGitBlameByGroup((current) => ({ ...current, [groupId]: blame }));
          })
          .catch(() => {
            cacheBlame(cacheKey, null);
            if (!cancelled) setGitBlameByGroup((current) => ({ ...current, [groupId]: null }));
          });
      }, 500));
    };
    for (const leafId of leafGroupIds) loadForGroup(leafId);
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    gitBlameRequestSignature,
    gitTargetForFile,
    intelligencePreferences.inlineBlameEnabled,
  ]);
  return {
    gitHeadTextByFile,
    gitBlameByGroup,
    gitLineChangesByFile,
    gitChangeByRootPath,
  };
}
