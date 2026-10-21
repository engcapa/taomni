import { useCallback } from "react";
import { workspaceReadFile } from "../../../../lib/editor/workspace";
import { fsPathEquals, normalizeFsPath, type OpenFileState } from "../codeWorkspaceModel";
import { createReadWorkspaceEditPathSnapshot } from "../controller/recoveryJournal";
import { collectReplacePreimages, type ReplaceFilePreimage, type ReplacePrepareOptions } from "../replaceInFilesModel";
import { useWorkspaceLspSession } from "../useWorkspaceLspSession";
import { useWorkspaceBufferState } from "./useWorkspaceBufferState";
import { useWorkspaceEditState } from "./useWorkspaceEditState";
import { useWorkspaceTreeModel } from "./useWorkspaceTreeModel";


export interface UseWorkspaceEditPlanningContext {
  bufferState: ReturnType<typeof useWorkspaceBufferState>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  lsp: ReturnType<typeof useWorkspaceLspSession>;
  projectTree: ReturnType<typeof useWorkspaceTreeModel>;
  workspaceInstanceId: string;
  editState: ReturnType<typeof useWorkspaceEditState>;
}

export function useWorkspaceEditPlanning(context: UseWorkspaceEditPlanningContext) {
  const { bufferState, absolutePathForOpenFile, lsp, projectTree, workspaceInstanceId, editState } = context;
  /**
   * ED-FOLLOW-003: path-keyed open-buffer view for buildRefactorPlan.
   * The live openFiles map is keyed by file key (`root:<id>:<path>`), which
   * matchOpenFile can never resolve — passing it straight through silently
   * disabled every open-buffer plan guard (dirty edits, revision skew). The
   * view re-keys by absolute path and file URI so the guards see the
   * buffers. Deliberately narrow: only staleness/dirty signals ride it
   * (documentRevision, LSP revision, dirty, library). Buffer text and disk
   * hashes stay out so the plan's hash machinery keeps its current
   * snapshot-driven semantics (notably the EOL-tolerant journal path).
   *
   * Revision is reported only while the server has NOT acknowledged the
   * latest buffer text (isLspDocumentSynced false). documentRevision bumps
   * per edit while the sync version bumps per flushed didChange, so a
   * coalesced burst always skews the counters even though the server holds
   * the latest text — reporting the raw version would false-positive every
   * rename after any typing burst. Omitting it when synced makes the plan
   * guard mean exactly "the server has not seen the latest bytes".
   */
  const buildPlanOpenFiles = useCallback((): Record<string, {
    documentRevision?: number;
    revision?: number;
    canonicalPath?: string;
    dirty?: boolean;
    library?: unknown;
  }> => {
    const view: Record<string, {
      documentRevision?: number;
      revision?: number;
      canonicalPath?: string;
      dirty?: boolean;
      library?: unknown;
    }> = {};
    for (const file of Object.values(bufferState.openFilesRef.current)) {
      if (file.loading) continue;
      const absolutePath = absolutePathForOpenFile(file);
      if (!absolutePath) continue;
      const normalized = normalizeFsPath(absolutePath);
      const entry: {
        documentRevision?: number;
        revision?: number;
        canonicalPath?: string;
        dirty?: boolean;
        library?: unknown;
      } = {
        documentRevision: file.documentRevision,
        canonicalPath: normalized,
        dirty: file.dirty === true,
      };
      if (!lsp.isDocumentSynced(file.key, file.text)) {
        const syncedRevision = lsp.documentVersion(file.key);
        if (syncedRevision !== null && syncedRevision !== undefined) {
          entry.revision = syncedRevision;
        }
      }
      if (file.library != null) {
        entry.library = file.library;
      }
      view[normalized] = entry;
      view[`file://${normalized}`] = entry;
    }
    return view;
  }, [absolutePathForOpenFile, lsp.isDocumentSynced, lsp.documentVersion]);

  const readWorkspaceEditPathSnapshot = useCallback(createReadWorkspaceEditPathSnapshot({
    openFilesRef: bufferState.openFilesRef,
    absolutePathForOpenFile,
    rootsRef: projectTree.rootsRef,
  }), [absolutePathForOpenFile]);

  // ED-MAIN-005 / ED-REPAIR-005: read the frozen per-file preimage before the replace preview
  // can be confirmed. Validates frozen workspace instance, roots, and buffer states across
  // all async reads; aborts or fails cleanly if states change mid-read.
  const prepareReplacePreimages = useCallback(async (
    paths: readonly string[],
    options?: ReplacePrepareOptions,
  ): Promise<readonly ReplaceFilePreimage[]> => {
    return collectReplacePreimages({
      paths,
      options,
      initialWorkspaceInstanceId: workspaceInstanceId,
      getCurrentWorkspaceInstanceId: () => workspaceInstanceId,
      getCurrentRoots: () => projectTree.rootsRef.current,
      getOpenFileState: (absolute) => {
        const open = Object.values(bufferState.openFilesRef.current).find((file) => {
          const currentPath = absolutePathForOpenFile(file);
          return currentPath !== null && fsPathEquals(currentPath, absolute);
        });
        if (!open) return null;
        return {
          documentRevision: open.documentRevision ?? null,
          dirty: open.dirty ?? false,
          readOnly: !!open.library,
        };
      },
      readFile: (rootPath, relativePath) => workspaceReadFile(rootPath, relativePath),
      isLocked: () => editState.workspaceResourceOperationLockedRef.current,
    });
  }, [absolutePathForOpenFile, workspaceInstanceId]);
  return { readWorkspaceEditPathSnapshot, buildPlanOpenFiles, prepareReplacePreimages };
}
