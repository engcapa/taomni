import type { ViewerDocument } from "../lib/viewer";

export const VIEWER_DRAFTS_KEY = "taomni.viewer.drafts.v1";
export const MAX_LOCALSTORAGE_DRAFT_CHARS = 512 * 1024;
export type ViewerDraft = Pick<
  ViewerDocument,
  "path" | "content" | "savedContent" | "savedHash" | "encoding" | "bom" | "eol" | "savedEncoding" | "savedBom" | "savedEol" | "originalLineEndings"
> & { updatedAt?: number };

export function readViewerDrafts(): Record<string, ViewerDraft> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VIEWER_DRAFTS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => {
      const draft = value as Partial<ViewerDraft> | null;
      return draft && typeof draft.path === "string" && typeof draft.content === "string"
        && typeof draft.savedHash === "string" && typeof draft.savedContent === "string"
        && typeof draft.encoding === "string" && ["LF", "CRLF", "CR", "mixed"].includes(draft.eol ?? "");
    }));
  } catch { return {}; }
}

/** Drop stale localStorage entries so a fresh native snapshot is not shadowed on restore. */
export function removeViewerDraftEntries(keys: Iterable<string>): void {
  try {
    const drafts = readViewerDrafts();
    let removed = false;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(drafts, key)) {
        delete drafts[key];
        removed = true;
      }
    }
    if (removed) localStorage.setItem(VIEWER_DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Storage unavailable: the native snapshot still remains the freshest copy.
  }
}

export function writeViewerDrafts(documents: Record<string, ViewerDocument>): void {
  const drafts = readViewerDrafts();
  const now = Date.now();
  for (const [key, document] of Object.entries(documents)) {
    // Do not discard persisted drafts before an in-flight load (or failed read) applies readViewerDrafts().
    if (document.loading || document.error) continue;
    if (
      !document.dirty ||
      document.readOnly ||
      document.content.length > MAX_LOCALSTORAGE_DRAFT_CHARS ||
      document.savedContent.length > MAX_LOCALSTORAGE_DRAFT_CHARS
    ) {
      delete drafts[key];
      continue;
    }
    drafts[key] = {
      path: document.path, content: document.content, savedContent: document.savedContent,
      savedHash: document.savedHash, encoding: document.encoding, bom: document.bom, eol: document.eol,
      savedEncoding: document.savedEncoding, savedBom: document.savedBom, savedEol: document.savedEol,
      originalLineEndings: document.originalLineEndings,
      updatedAt: now,
    };
  }
  localStorage.setItem(VIEWER_DRAFTS_KEY, JSON.stringify(drafts));
}
