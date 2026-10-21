import { useCallback } from "react";
import { type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { getAllLeafNodes, cloneLayoutTree, type LayoutNode } from "../recursiveLayoutTree";
import { workspaceEditOperations } from "../workspaceEditPreview";
import { type WorkspaceEditPathSnapshot } from "../workspaceEditHistory";
import { extractAffectedResourcesFromWorkspaceEdit, type CodeActionTransactionSnapshot } from "../codeActionProviderAdapter";
import { mergeWorkspaceBookmarkSnapshot, writeWorkspaceBookmarks, type WorkspaceBookmark } from "../todoBookmarks";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, absoluteWorkspacePath, fileKey, fsPathComparisonKey, normalizeFsPath } from "../codeWorkspaceModel";
import { type WorkspaceEditTabSnapshot } from "../controller/model";


export interface UseWorkspaceEditSnapshotsContext {
  readWorkspaceEditPathSnapshot: (absolutePath: string) => Promise<WorkspaceEditPathSnapshot | null>;
  replayWorkspacePathSnapshotsRef: import("react").RefObject<(snapshots: readonly WorkspaceEditPathSnapshot[]) => Promise<void>>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  bookmarksRef: import("react").RefObject<WorkspaceBookmark[]>;
  workspaceInstanceId: string;
  replaceBookmarks: (next: WorkspaceBookmark[]) => void;
  setLayoutTreeV2Store: (instanceId: string, layoutTree: LayoutNode) => void;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  updateEditorGroup: (groupId: EditorGroupId, updater: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceEditorGroupState | ((prev: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceEditorGroupState) => import("../../../../stores/codeWorkspaceStore").CodeWorkspaceEditorGroupState)) => void;
  activateEditorGroup: (groupId: EditorGroupId) => void;
}

export function useWorkspaceEditSnapshots(context: UseWorkspaceEditSnapshotsContext) {
  const {
    readWorkspaceEditPathSnapshot,
    replayWorkspacePathSnapshotsRef,
    openFilesRef,
    absolutePathForOpenFile,
    rootsRef,
    bookmarksRef,
    workspaceInstanceId,
    replaceBookmarks,
    setLayoutTreeV2Store,
    openFile,
    updateEditorGroup,
    activateEditorGroup,
  } = context;

  const captureWorkspaceEditPathSnapshots = useCallback(async (
    edit: LspWorkspaceEdit,
  ): Promise<WorkspaceEditPathSnapshot[] | null> => {
    const paths: string[] = [];
    const seen = new Set<string>();
    const add = (path: string | null) => {
      if (!path) return false;
      const normalized = normalizeFsPath(path);
      const comparisonKey = fsPathComparisonKey(normalized);
      if (!seen.has(comparisonKey)) {
        seen.add(comparisonKey);
        paths.push(normalized);
      }
      return true;
    };
    for (const operation of workspaceEditOperations(edit)) {
      if (operation.kind === "text") {
        if (!add(operation.document.path)) return null;
      } else if (operation.kind === "rename") {
        if (!add(operation.oldPath) || !add(operation.newPath)) return null;
      } else if (!add(operation.path)) {
        return null;
      }
    }
    const snapshots = await Promise.all(paths.map(readWorkspaceEditPathSnapshot));
    return snapshots.every((snapshot): snapshot is WorkspaceEditPathSnapshot => snapshot !== null)
      ? snapshots
      : null;
  }, [readWorkspaceEditPathSnapshot]);

  const captureCodeActionTransactionSnapshot = useCallback(async (
    edit: LspWorkspaceEdit,
  ): Promise<CodeActionTransactionSnapshot | null> => {
    const pathSnapshots = await captureWorkspaceEditPathSnapshots(edit);
    if (!pathSnapshots) return null;
    const byPath = new Map(pathSnapshots.map((snapshot) => [
      fsPathComparisonKey(snapshot.path),
      snapshot,
    ]));
    const resources = [];
    for (const resource of extractAffectedResourcesFromWorkspaceEdit(edit)) {
      if (!resource.path) return null;
      const path = normalizeFsPath(resource.path);
      const snapshot = byPath.get(fsPathComparisonKey(path));
      if (!snapshot) return null;
      resources.push({
        uri: resource.uri || path,
        path,
        exists: snapshot.exists,
        text: snapshot.text,
        encoding: snapshot.encoding,
        bom: snapshot.bom,
        eol: snapshot.eol,
      });
    }
    return { resources };
  }, [captureWorkspaceEditPathSnapshots]);

  const restoreCodeActionTransactionSnapshot = useCallback(async (
    snapshot: CodeActionTransactionSnapshot,
  ) => {
    const byPath = new Map<string, WorkspaceEditPathSnapshot>();
    for (const resource of snapshot.resources) {
      const path = normalizeFsPath(resource.path);
      byPath.set(fsPathComparisonKey(path), {
        path,
        exists: resource.exists,
        text: resource.text,
        encoding: resource.encoding,
        bom: resource.bom,
        eol: resource.eol,
      });
    }
    await replayWorkspacePathSnapshotsRef.current([...byPath.values()]);
  }, []);

  const absolutePathForBookmark = useCallback((bookmark: WorkspaceBookmark): string | null => {
    const open = openFilesRef.current[bookmark.fileKey];
    if (open) return absolutePathForOpenFile(open);
    for (const root of rootsRef.current) {
      const prefix = `root:${root.id}:`;
      if (bookmark.fileKey.startsWith(prefix)) {
        return absoluteWorkspacePath(root, bookmark.fileKey.slice(prefix.length));
      }
    }
    return null;
  }, [absolutePathForOpenFile]);

  const captureWorkspaceEditBookmarkSnapshot = useCallback((paths: readonly string[]): WorkspaceBookmark[] => {
    const affectedPaths = new Set(paths.map((path) => fsPathComparisonKey(path)));
    return bookmarksRef.current.filter((bookmark) => {
      const path = absolutePathForBookmark(bookmark);
      return path !== null && affectedPaths.has(fsPathComparisonKey(path));
    });
  }, [absolutePathForBookmark]);

  const restoreWorkspaceBookmarkSnapshot = useCallback((
    snapshot: readonly WorkspaceBookmark[],
    affectedIds: readonly string[],
  ) => {
    if (affectedIds.length === 0) return;
    const next = mergeWorkspaceBookmarkSnapshot(bookmarksRef.current, snapshot, affectedIds);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    replaceBookmarks(next);
  }, [replaceBookmarks, workspaceInstanceId]);

  const captureWorkspaceEditTabSnapshot = useCallback((
    paths: readonly string[],
  ): WorkspaceEditTabSnapshot => {
    const pathSet = new Set(paths.map(fsPathComparisonKey));
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    // §8.16.4 N6.6: snapshot every leaf at any depth, not just the legacy
    // primary/secondary pair; the full tree (with ratios) is captured so a
    // failed WorkspaceEdit restores the entire layout.
    const groupIds: EditorGroupId[] = getAllLeafNodes(ui.layoutTreeV2).map((leaf) => leaf.id);
    const files = Object.values(openFilesRef.current).flatMap((file) => {
      const absolutePath = absolutePathForOpenFile(file);
      if (!absolutePath || !pathSet.has(fsPathComparisonKey(absolutePath))) return [];
      const groups = groupIds.flatMap((id) => {
        const group = ui.editorGroups[id];
        if (!group || !group.openOrder.includes(file.key)) return [];
        return [{
          id,
          active: group.activeKey === file.key,
          preview: group.previewKey === file.key,
          pinned: group.pinnedKeys.includes(file.key),
        }];
      });
      return groups.length > 0 ? [{ path: normalizeFsPath(absolutePath), ref: file.ref, groups }] : [];
    });
    return {
      activeGroupId: ui.activeEditorGroupId,
      splitOrientation: ui.splitOrientation,
      layoutTreeV2: cloneLayoutTree(ui.layoutTreeV2),
      files,
    };
  }, [absolutePathForOpenFile, workspaceInstanceId]);

  const restoreWorkspaceEditTabs = useCallback(async (snapshot: WorkspaceEditTabSnapshot) => {
    // §8.16.4 N6.6: restore the entire recursive tree (structure + ratios)
    // before reopening tabs so a failed WorkspaceEdit recovers every leaf,
    // not just the two legacy groups.
    setLayoutTreeV2Store(workspaceInstanceId, cloneLayoutTree(snapshot.layoutTreeV2));
    for (const file of snapshot.files) {
      for (const group of file.groups) {
        await openFile(file.ref, { preview: group.preview, groupId: group.id });
        const key = fileKey(file.ref);
        updateEditorGroup(group.id, (current) => ({
          ...current,
          activeKey: group.active ? key : current.activeKey,
          previewKey: group.preview ? key : current.previewKey === key ? null : current.previewKey,
          pinnedKeys: group.pinned
            ? [...new Set([...current.pinnedKeys, key])]
            : current.pinnedKeys.filter((candidate) => candidate !== key),
        }));
      }
    }
    activateEditorGroup(snapshot.activeGroupId);
  }, [activateEditorGroup, openFile, updateEditorGroup, workspaceInstanceId]);
  return { captureWorkspaceEditPathSnapshots, captureWorkspaceEditBookmarkSnapshot, captureWorkspaceEditTabSnapshot, restoreWorkspaceBookmarkSnapshot, restoreWorkspaceEditTabs, captureCodeActionTransactionSnapshot, restoreCodeActionTransactionSnapshot };
}
