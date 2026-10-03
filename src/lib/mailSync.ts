import type {
  MailFolder,
  MailFolderSyncResult,
  MailMessageHeader,
  MailSyncRequestMode,
} from "./mail";

/**
 * Gap-free folder sync orchestration (see src-tauri/src/mail/sync.rs).
 *
 * The backend syncs one bounded step per call and reports `more` while work
 * remains; this loop repeats the step so a long absence (hundreds of new
 * messages) is fully caught up instead of only the newest page.
 */
export interface FolderSyncLoopProgress {
  steps: number;
  fetched: number;
  newUnseen: number;
  remaining: number;
}

export interface FolderSyncLoopOptions {
  mode?: MailSyncRequestMode;
  /** Upper bound per run; remaining work is picked up by the next run. */
  maxSteps?: number;
  step: (mode: MailSyncRequestMode) => Promise<MailFolderSyncResult>;
  /** Checked before every step; a stale run stops without further calls. */
  isCancelled?: () => boolean;
  onStep?: (result: MailFolderSyncResult, progress: FolderSyncLoopProgress) => void | Promise<void>;
}

export interface FolderSyncLoopResult extends FolderSyncLoopProgress {
  last: MailFolderSyncResult | null;
  cancelled: boolean;
  /** True when maxSteps ended the run while the backend still had work. */
  exhausted: boolean;
}

export async function runFolderSyncLoop(options: FolderSyncLoopOptions): Promise<FolderSyncLoopResult> {
  const mode = options.mode ?? "auto";
  const maxSteps = Math.max(1, options.maxSteps ?? 50);
  const progress: FolderSyncLoopProgress = { steps: 0, fetched: 0, newUnseen: 0, remaining: 0 };
  let last: MailFolderSyncResult | null = null;
  while (progress.steps < maxSteps) {
    if (options.isCancelled?.()) {
      return { ...progress, last, cancelled: true, exhausted: false };
    }
    const result = await options.step(mode);
    last = result;
    progress.steps += 1;
    progress.fetched += result.fetched;
    progress.newUnseen += result.newUnseen;
    progress.remaining = result.remainingNew;
    await options.onStep?.(result, { ...progress });
    if (!result.more) {
      return { ...progress, last, cancelled: false, exhausted: false };
    }
  }
  return { ...progress, last, cancelled: false, exhausted: Boolean(last?.more) };
}

/** Replace one folder's metadata in the folder list (or append it). */
export function mergeFolderMeta(folders: readonly MailFolder[], next: MailFolder): MailFolder[] {
  let found = false;
  const merged = folders.map((folder) => {
    if (folder.name !== next.name) return folder;
    found = true;
    return { ...folder, ...next, displayName: next.displayName ?? folder.displayName };
  });
  return found ? merged : [...merged, next];
}

/**
 * Whether more messages can be loaded below `loadedCount`: either the cache
 * still has rows, or the server has older history that has not been
 * backfilled. A retention-bounded span is complete, so it never loops.
 */
export function folderHasMoreToLoad(
  folder: MailFolder | undefined,
  loadedCount: number,
  cachePageHasMore: boolean,
): boolean {
  if (cachePageHasMore) return true;
  if (!folder) return false;
  if (typeof folder.cachedCount === "number" && folder.cachedCount > loadedCount) return true;
  if (folder.syncComplete) return false;
  return typeof folder.total === "number" && folder.total > loadedCount;
}

/**
 * Merge freshly synced headers into the visible list, but only when the user
 * is still on the synced folder (a folder switch during an await must not
 * rewrite the new folder's list).
 */
export function mergeSyncedMessages(
  selectedFolderNow: string,
  syncedFolder: string,
  current: readonly MailMessageHeader[],
  synced: readonly MailMessageHeader[],
  sort: (messages: MailMessageHeader[]) => MailMessageHeader[],
): MailMessageHeader[] | null {
  if (selectedFolderNow !== syncedFolder) return null;
  const byKey = new Map<string, MailMessageHeader>();
  for (const message of current) {
    if (message.folder === syncedFolder) byKey.set(`${message.folder}:${message.uid}`, message);
  }
  for (const message of synced) byKey.set(`${message.folder}:${message.uid}`, message);
  return sort(Array.from(byKey.values()));
}

/** Sum new unseen mail, skipping folders the caller excludes (Sent, Trash…). */
export function countNewMail(
  newUnseenByFolder: Record<string, number> | undefined,
  folders: readonly MailFolder[],
  excluded: (folder: MailFolder) => boolean,
): number {
  if (!newUnseenByFolder) return 0;
  let total = 0;
  for (const [name, count] of Object.entries(newUnseenByFolder)) {
    const folder = folders.find((entry) => entry.name === name);
    if (folder && excluded(folder)) continue;
    total += Math.max(0, count);
  }
  return total;
}

/** Pre-watermark defaults; a stored value equal to these was never chosen by the user. */
export const LEGACY_MAIL_HEADER_RETENTION_DAYS = 30;
export const LEGACY_MAIL_HEADER_LIMIT_PER_FOLDER = 2000;

/** Saved by the current session editor: header limits are explicit user values. */
export const MAIL_HEADER_LIMITS_EXPLICIT_KEY = "mailHeaderLimitsExplicit";

/**
 * Header cache limit from saved session options: 0 means unlimited (full
 * local header index). Options saved before the full index existed carry the
 * old implicit defaults (30 days / 2000); those migrate to 0 (DEC-08) unless
 * the options were saved by an editor that marks limits as explicit.
 */
export function mailHeaderLimitOption(
  options: Record<string, unknown>,
  key: string,
  legacyDefault: number,
): number {
  const raw = options[key];
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n === legacyDefault && options[MAIL_HEADER_LIMITS_EXPLICIT_KEY] !== true) return 0;
  return Math.round(n);
}
