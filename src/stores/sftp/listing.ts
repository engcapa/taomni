import { sftpListLocalDetailed, sftpListRemote, sftpLocalDrives, type DirectoryListing, type FileEntry } from "../../lib/sftp";
import { type PaneSide, type PaneState, type SftpSessionState } from "./model";

/**
 * Virtual path used by the local pane on Windows to display the list of
 * available drive letters as if they were folder entries. Reaching it via
 * the breadcrumb's "Up" / Home or via the new drives picker lets users
 * jump back from `C:\foo` to a drives view without typing.
 */
export const WINDOWS_DRIVES_ROOT = "\\\\";

export function emptyPane(): PaneState {
  return {
    path: "",
    entries: [],
    selection: [],
    loading: false,
    error: null,
    skippedEntryCount: 0,
    entryDiagnostics: [],
    history: [],
    historyIndex: -1,
    showHidden: false,
  };
}

export function freshSession(sessionId: string): SftpSessionState {
  return {
    sessionId,
    attached: false,
    attaching: false,
    homeDir: null,
    error: null,
    remote: emptyPane(),
    local: emptyPane(),
  };
}

export function pushHistory(pane: PaneState, path: string): PaneState {
  if (pane.history[pane.historyIndex] === path) {
    return pane;
  }
  const trimmed = pane.history.slice(0, pane.historyIndex + 1);
  trimmed.push(path);
  return {
    ...pane,
    history: trimmed,
    historyIndex: trimmed.length - 1,
  };
}

export async function listSide(
  sessionId: string,
  side: PaneSide,
  path: string,
): Promise<DirectoryListing> {
  if (side === "local" && path === WINDOWS_DRIVES_ROOT) {
    // Synthesize folder-like entries from the available Windows drives so
    // the standard file-list UI (sort, double-click to enter, etc.) works
    // unchanged for the virtual drives root.
    const drives = await sftpLocalDrives();
    return {
      entries: drives.map<FileEntry>((d) => ({
        name: d.label,
        path: d.path,
        fileType: "dir",
        size: 0,
        mtime: 0,
        mode: 0,
        isHidden: false,
      })),
      skippedCount: 0,
      diagnostics: [],
    };
  }
  if (side === "local") return sftpListLocalDetailed(path);
  return {
    entries: await sftpListRemote(sessionId, path),
    skippedCount: 0,
    diagnostics: [],
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function listingState(listing: DirectoryListing): Pick<
  PaneState,
  "entries" | "skippedEntryCount" | "entryDiagnostics"
> {
  return {
    entries: listing.entries,
    skippedEntryCount: listing.skippedCount,
    entryDiagnostics: listing.diagnostics,
  };
}

export function emptyListing(): DirectoryListing {
  return { entries: [], skippedCount: 0, diagnostics: [] };
}

export async function loadInitialListing(
  sessionId: string,
  side: PaneSide,
  path: string,
): Promise<{ listing: DirectoryListing; error: string | null; }> {
  if (!path) return { listing: emptyListing(), error: null };
  try {
    return { listing: await listSide(sessionId, side, path), error: null };
  } catch (error) {
    return { listing: emptyListing(), error: errorMessage(error) };
  }
}

export function isConnectionError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes("connection closed") ||
    msg.includes("socket closed") ||
    msg.includes("channel closed") ||
    // russh-sftp raises this once its background I/O task ends (dropped
    // connection / idle timeout); the backend attempts a transparent
    // reconnect, but if that fails we still want the reconnect banner.
    msg.includes("session closed") ||
    msg.includes("sender dropped") ||
    msg.includes("broken pipe") ||
    msg.includes("connection reset") ||
    msg.includes("not attached") ||
    msg.includes("not connected") ||
    msg.includes("ssh error") ||
    msg.includes("io error") ||
    msg.includes("timed out") ||
    msg.includes("eof")
  );
}

export function isSftpRefreshDirectorySignal(err: unknown): boolean {
  return errorMessage(err)
    .toLowerCase()
    .includes("character is changed please refresh directory");
}
