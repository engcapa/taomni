import { notepadBackupWrite } from "../ipc";

export const LEGACY_VIEWER_DRAFTS_KEY = "taomni.viewer.drafts.v1";
export const DRAFTS_MIGRATED_KEY = "taomni.notepad.draftsMigrated.v1";

interface LegacyDraftEntry {
  content?: string;
  baseHash?: string;
  encoding?: string;
  bom?: boolean;
  eol?: string;
  updatedAt?: number;
}

/**
 * One-time migration moving legacy `taomni.viewer.drafts.v1` localStorage entries
 * into native disk backups (`appData/notepad/backups/`).
 */
export async function migrateLegacyViewerDrafts(): Promise<number> {
  if (typeof localStorage === "undefined") return 0;
  if (localStorage.getItem(DRAFTS_MIGRATED_KEY) === "1") return 0;

  let migrated = 0;
  const raw = localStorage.getItem(LEGACY_VIEWER_DRAFTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, LegacyDraftEntry>;
      if (parsed && typeof parsed === "object") {
        const remaining: Record<string, LegacyDraftEntry> = {};
        for (const [pathKey, entry] of Object.entries(parsed)) {
          if (entry && typeof entry.content === "string") {
            const name = pathKey.split(/[\\/]/).pop() || pathKey;
            await notepadBackupWrite({
              docId: pathKey,
              path: pathKey.startsWith("untitled:") ? null : pathKey,
              name,
              content: entry.content,
              encoding: entry.encoding || "UTF-8",
              bom: Boolean(entry.bom),
              eol: entry.eol || "LF",
              savedHash: entry.baseHash || "",
            });
            migrated += 1;
          } else {
            remaining[pathKey] = entry;
          }
        }
        if (Object.keys(remaining).length === 0) {
          localStorage.removeItem(LEGACY_VIEWER_DRAFTS_KEY);
        } else {
          localStorage.setItem(LEGACY_VIEWER_DRAFTS_KEY, JSON.stringify(remaining));
        }
      }
    } catch {
      // Do not crash startup on corrupt legacy draft storage
    }
  }
  localStorage.setItem(DRAFTS_MIGRATED_KEY, "1");
  return migrated;
}
