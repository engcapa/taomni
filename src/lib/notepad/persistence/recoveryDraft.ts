import { notepadBackupWrite, type NotepadBackupEntry } from "../ipc";
import { isUntitledKey } from "../../openFile/pathIdentity";
import type { ViewerDocument } from "../../viewer";

/** Name Notepad's recovery surfaces use for a document snapshot. */
export function recoveryDraftName(document: ViewerDocument, titleHint?: string): string {
  if (titleHint) return titleHint;
  if (isUntitledKey(document.path)) return "Untitled";
  return document.path.split(/[\\/]/).pop() || document.path;
}

/**
 * Persist the exact unsaved buffer as a native Notepad recovery snapshot.
 * Used when the document is too large for the bounded localStorage draft or
 * when localStorage cannot accept the write, so "keep draft" stays recoverable.
 */
export function writeRecoveryDraft(document: ViewerDocument, name: string): Promise<NotepadBackupEntry> {
  return notepadBackupWrite({
    docId: document.key,
    path: isUntitledKey(document.path) ? null : document.path,
    name,
    content: document.content,
    encoding: document.encoding,
    bom: document.bom,
    eol: document.eol,
    savedHash: document.savedHash,
  });
}
