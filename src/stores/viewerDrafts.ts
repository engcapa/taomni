import type { ViewerDocument } from "../lib/viewer";

export const VIEWER_DRAFTS_KEY = "taomni.viewer.drafts.v1";
export type ViewerDraft = Pick<ViewerDocument, "path" | "content" | "savedContent" | "savedHash" | "encoding" | "bom" | "eol" | "savedEncoding" | "savedBom" | "savedEol" | "originalLineEndings">;

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

export function writeViewerDrafts(documents: Record<string, ViewerDocument>): void {
  const drafts = readViewerDrafts();
  for (const [key, document] of Object.entries(documents)) {
    // A reload publishes a loading document before its disk content arrives.
    // Keep an existing draft through that transient state; the completed
    // document will reconcile it once loading finishes.
    if (document.loading) continue;
    if (!document.dirty || document.readOnly) { delete drafts[key]; continue; }
    drafts[key] = {
      path: document.path, content: document.content, savedContent: document.savedContent,
      savedHash: document.savedHash, encoding: document.encoding, bom: document.bom, eol: document.eol,
      savedEncoding: document.savedEncoding, savedBom: document.savedBom, savedEol: document.savedEol,
      originalLineEndings: document.originalLineEndings,
    };
  }
  localStorage.setItem(VIEWER_DRAFTS_KEY, JSON.stringify(drafts));
}
