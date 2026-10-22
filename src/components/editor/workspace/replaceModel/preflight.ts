import { type ReplacePreflightConflict, type ReplacePreflightFileInput, type ReplacePreflightResult, type ReplacePreviewSnapshot } from "./model";
import { findReplacePreimage } from "./preimages";

/**
 * ED-REPAIR-002: Atomic whole-set preflight check before any file mutation.
 * Verifies that all selected files exist, match their frozen preimages on disk,
 * and have matching buffer revision and clean/read-write status. If any file fails,
 * the entire replace plan is rejected with zero mutations.
 */
export function validateReplacePreflight(
  snapshot: ReplacePreviewSnapshot,
  currentWorkspaceInstanceId: string,
  files: readonly ReplacePreflightFileInput[],
): ReplacePreflightResult {
  const conflicts: ReplacePreflightConflict[] = [];

  if (snapshot.requestIdentity && snapshot.requestIdentity.workspaceInstanceId !== currentWorkspaceInstanceId) {
    return {
      canCommit: false,
      conflicts: [{
        path: "workspace",
        reason: `workspace instance mismatch (snapshot: ${snapshot.requestIdentity.workspaceInstanceId}, current: ${currentWorkspaceInstanceId}); reopen the preview`,
      }],
    };
  }

  for (const file of files) {
    if (!file.exists || file.diskHash === null || file.diskText === null) {
      conflicts.push({
        path: file.path,
        reason: "file not found on disk or unreadable; reopen the preview",
      });
      continue;
    }

    const preimage = findReplacePreimage(snapshot, file.path);
    if (!preimage) {
      conflicts.push({
        path: file.path,
        reason: "file is not part of the frozen replace preview; reopen the preview",
      });
      continue;
    }

    if (preimage.workspaceInstanceId && preimage.workspaceInstanceId !== currentWorkspaceInstanceId) {
      conflicts.push({
        path: file.path,
        reason: `workspace instance changed since preview (${preimage.workspaceInstanceId} -> ${currentWorkspaceInstanceId}); reopen the preview`,
      });
      continue;
    }

    // Disk hash precondition
    if (file.diskHash !== preimage.textHash) {
      conflicts.push({
        path: file.path,
        reason: `${file.path} changed on disk since the frozen replace preview; reopen the preview`,
      });
      continue;
    }

    // Open buffer session and revision precondition
    const wasOpenAtPreview = preimage.bufferRevision !== null;
    if (file.isOpen !== wasOpenAtPreview) {
      conflicts.push({
        path: file.path,
        reason: file.isOpen
          ? `${file.path} was opened in the editor since the frozen preview; reopen the preview`
          : `${file.path} was closed in the editor since the frozen preview; reopen the preview`,
      });
      continue;
    }

    if (file.isOpen) {
      if (file.openBufferDirty) {
        conflicts.push({
          path: file.path,
          reason: `${file.path} has unsaved modifications in the editor`,
        });
      }
      if (file.openBufferReadOnly) {
        conflicts.push({
          path: file.path,
          reason: `${file.path} is read-only in the editor`,
        });
      }
      if (preimage.bufferRevision !== null && file.openBufferRevision !== preimage.bufferRevision) {
        conflicts.push({
          path: file.path,
          reason: `${file.path} was modified in the editor since the frozen replace preview (revision changed from ${preimage.bufferRevision} to ${file.openBufferRevision}); reopen the preview`,
        });
      }
    }
  }

  return {
    canCommit: conflicts.length === 0,
    conflicts,
  };
}
