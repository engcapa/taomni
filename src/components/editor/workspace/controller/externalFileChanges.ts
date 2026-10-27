import type { LspExternalFileChange } from "../../../../lib/editor/lsp";
import type { WorkspaceStyleController } from "../workspaceStyleController";
import { type OpenFileState, errorMessage, fsPathComparisonKey, fsPathEquals, normalizeFsPath } from "../codeWorkspaceModel";
import type { ExternalDiskSnapshot } from "./model";

export interface HandleExternalFileChangeContext {
  workspaceStyleControllerRef: import("react").RefObject<WorkspaceStyleController>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  refreshTree: () => void;
  restoreEchoSuppressorRef: import("react").RefObject<import("../refactorRecoveryController").RestoreEchoSuppressor>;
  setStatusMessage: (message: string) => void;
  enqueueExternalFileConflict: (file: OpenFileState, disk: ExternalDiskSnapshot | null) => void;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
  readDiskSnapshot: (file: OpenFileState) => Promise<ExternalDiskSnapshot>;
  applyDiskSnapshot: (file: OpenFileState, disk: ExternalDiskSnapshot) => void;
}


export function createHandleExternalFileChange(controllerContext: HandleExternalFileChangeContext) {
  return async (change: LspExternalFileChange) => {
    const normalizedPath = normalizeFsPath(change.path);
    if (normalizedPath.endsWith(".editorconfig")) {
      controllerContext.workspaceStyleControllerRef.current.invalidate(normalizedPath);
    }
    // The semantic revision only moves for a real content change: the watcher
    // echo of our own save (or of a restore) re-delivers what the open buffer
    // already holds, and must not cancel a rename whose dialog is open
    // (Extract Method's naming prompt, ED-AUDIT-008 freshness contract).
    const invalidateSemantics = () => controllerContext.semanticIndex.invalidate("external-file-change", [normalizedPath]);
    const file = Object.values(controllerContext.openFilesRef.current).find((candidate) => {
      const absolute = controllerContext.absolutePathForOpenFile(candidate);
      return absolute !== null && fsPathEquals(absolute, normalizedPath);
    });
    controllerContext.refreshTree();
    // Restore can remap a renamed file back into the open-file registry before
    // Windows delivers the old delete notification. Consume that owned echo
    // before either the open- or closed-file status path handles it.
    if (controllerContext.restoreEchoSuppressorRef.current.shouldSuppress(fsPathComparisonKey(normalizedPath))) return;
    if (!file) {
      invalidateSemantics();
      // Background tools also create closed metadata files (for example
      // jdtls .project). Refresh their consumers without replacing the result
      // of the user's command. Open-buffer changes below still surface reload,
      // deletion and conflict feedback.
      return;
    }
    if (file.library) {
      invalidateSemantics();
      return;
    }
    if (file.saving) {
      return;
    }
    let disk: ExternalDiskSnapshot;
    try {
      // Windows may deliver the delete half of an atomic replacement after
      // the new file is already in place. Verify the current disk bytes before
      // treating that notification as a deletion or interrupting an undo.
      disk = await controllerContext.readDiskSnapshot(file);
    } catch (error) {
      const latest = controllerContext.openFilesRef.current[file.key];
      if (!latest || latest.saving) return;
      invalidateSemantics();
      if (change.type !== 3) {
        controllerContext.setStatusMessage(`Cannot read external change for ${latest.subtitle}: ${errorMessage(error)}`);
      } else if (latest.dirty) {
        controllerContext.enqueueExternalFileConflict(latest, null);
        controllerContext.setStatusMessage(`${latest.subtitle} was deleted on disk; choose how to recover the local buffer`);
      } else {
        controllerContext.setOpenFiles((current) => ({
          ...current,
          [latest.key]: {
            ...(current[latest.key] ?? latest),
            error: "File deleted on disk; the open buffer is preserved",
          },
        }));
        controllerContext.setStatusMessage(`${latest.subtitle} was deleted on disk`);
      }
      return;
    }
    const latest = controllerContext.openFilesRef.current[file.key];
    if (!latest || latest.saving) return;
    if (disk.hash === latest.hash) {
      // The bytes are still our accepted disk snapshot. A delayed save echo
      // or chmod notification must not replace the selected encoding with
      // the decoder's canonical alias (ISO-8859-1 reads as windows-1252),
      // nor clear a newer edit or a failed-save state.
      controllerContext.setOpenFiles((current) => ({
        ...current,
        [file.key]: { ...(current[file.key] ?? latest), mtime: disk.mtime, size: disk.size },
      }));
      return;
    }
    // A delayed watcher echo of our last save can arrive after the user
    // chooses a new encoding/EOL without editing the logical text. Keep that
    // unsaved policy while refreshing the disk guard.
    const preservePolicy = latest.dirty && (
      latest.eol !== disk.eol
      || latest.encoding !== disk.encoding
      || latest.bom !== disk.bom
    );
    if (disk.text !== latest.text && disk.text !== latest.savedText) invalidateSemantics();
    if (disk.text === latest.text) {
      // Another process wrote exactly the buffer we already have. Accept the
      // new hash and clear dirty without repainting the editor document.
      controllerContext.setOpenFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? latest),
          savedText: disk.text,
          ...(preservePolicy ? {} : { eol: disk.eol, encoding: disk.encoding, bom: disk.bom }),
          hash: disk.hash,
          mtime: disk.mtime,
          size: disk.size,
          dirty: preservePolicy,
          error: null,
        },
      }));
      return;
    }
    if (disk.text === latest.savedText) {
      // Metadata-only/atomic-replace notification: the logical content did not
      // change, so preserve a dirty buffer and just refresh its write guard.
      controllerContext.setOpenFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? latest),
          ...(preservePolicy ? {} : { eol: disk.eol, encoding: disk.encoding, bom: disk.bom }),
          hash: disk.hash,
          mtime: disk.mtime,
          size: disk.size,
          error: null,
        },
      }));
      return;
    }
    if (!latest.dirty) {
      controllerContext.applyDiskSnapshot(latest, disk);
      controllerContext.setStatusMessage(`Reloaded ${latest.subtitle} from disk`);
      return;
    }
    controllerContext.enqueueExternalFileConflict(latest, disk);
    controllerContext.setStatusMessage(`${latest.subtitle} changed on disk; choose Keep Local, Load Disk, or Merge`);
  };
}
