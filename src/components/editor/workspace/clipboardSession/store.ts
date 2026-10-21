import type { ClipboardSourceEol } from "../workspaceEditorCommands";
import { type ClipboardClearReason, type ClipboardHistoryExclusion, type EditorClipboardSession, type HistoryEntry, type PastePlan } from "./model";

export let sessionSequence = 0;

export function nextSessionId(): string {
  sessionSequence += 1;
  return `clip-${Date.now().toString(36)}-${sessionSequence}`;
}

// ---------------------------------------------------------------------------
// C3b clipboard history ring (session-only, never persisted)
// ---------------------------------------------------------------------------

export const CLIPBOARD_HISTORY_MAX_ITEMS = 50;

export const CLIPBOARD_HISTORY_MAX_ITEM_BYTES = 256 * 1024;

export const CLIPBOARD_HISTORY_MAX_TOTAL_BYTES = 1024 * 1024;

/**
 * Documented segment/caret mapping (§8.18.4 paste plan):
 * - N segments × N carets map 1:1.
 * - Fewer segments than carets cycle deterministically (never implicit loss).
 * - More segments than carets: extra segments are DROPPED, but flagged
 *   (`extra-segments-dropped`) instead of silently ignored.
 * - No segments: the plain text inserts whole at every caret.
 */
export function planPaste(input: {
  segments: readonly string[] | null;
  plainText: string;
  caretCount: number;
  rectangular: boolean;
  sourceEol: ClipboardSourceEol;
}): PastePlan {
  const { segments, caretCount, rectangular, sourceEol } = input;
  void input.plainText;
  if (!segments || segments.length === 0 || caretCount <= 0) {
    return { perCaret: Array.from({ length: Math.max(caretCount, 0) }, () => null), rectangular, sourceEol, degraded: caretCount > 1 ? "whole-block" : false };
  }
  if (segments.length === caretCount) {
    return { perCaret: [...segments], rectangular, sourceEol, degraded: false };
  }
  if (segments.length < caretCount) {
    return {
      perCaret: Array.from({ length: caretCount }, (_, index) => segments[index % segments.length]),
      rectangular,
      sourceEol,
      degraded: "fewer-segments-cycled",
    };
  }
  return {
    perCaret: Array.from({ length: caretCount }, (_, index) => segments[index]),
    rectangular,
    sourceEol,
    degraded: "extra-segments-dropped",
  };
}

export function detectSensitiveClipboardText(text: string): boolean {
  if (!text || text.length < 8) return false;
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i.test(text)) return true;
  if (/AKIA[0-9A-Z]{16}/.test(text)) return true;
  if (/(?:api[_-]?key|secret[_-]?key|password|token)\s*[:=]\s*['"][^\n'"]{8,}['"]/i.test(text)) return true;
  return false;
}

export class WorkspaceClipboardStore {
  private session: EditorClipboardSession | null = null;
  private history: HistoryEntry[] = [];
  private historyEnabled = true;
  private historyTotalBytes = 0;
  private historyMaxItems = CLIPBOARD_HISTORY_MAX_ITEMS;
  private historyMaxTotalBytes = CLIPBOARD_HISTORY_MAX_TOTAL_BYTES;
  private lastHistoryExclusion: ClipboardHistoryExclusion = "recorded";

  write(input: {
    sourceViewId: string | null;
    plainText: string;
    segments?: string[];
    rectangular: boolean;
    sourceEol: ClipboardSourceEol;
    systemClipboardUnavailable?: boolean;
    /** §8.19.5: secret-like payloads fill the slot but never the ring. */
    sensitive?: boolean;
    /** Oversized/binary payloads skip the C3b ring but still fill the slot. */
    historyEligible?: boolean;
  }): EditorClipboardSession {
    const isSensitive = Boolean(input.sensitive) || detectSensitiveClipboardText(input.plainText);
    const session: EditorClipboardSession = {
      sessionId: nextSessionId(),
      sourceViewId: input.sourceViewId,
      segments: input.segments ? [...input.segments] : null,
      rectangular: input.rectangular,
      plainText: input.plainText,
      sourceEol: input.sourceEol,
      createdAt: Date.now(),
      ...(input.systemClipboardUnavailable ? { systemClipboardUnavailable: true } : {}),
      ...(isSensitive ? { sensitive: true } : {}),
    };
    this.session = session;
    if (isSensitive) {
      this.lastHistoryExclusion = "sensitive";
    } else {
      this.recordHistory(session, input.historyEligible !== false);
    }
    return session;
  }

  read(): EditorClipboardSession | null {
    return this.session;
  }

  clear(reason: ClipboardClearReason = "workspace-close"): void {
    void reason;
    this.session = null;
    this.history = [];
    this.historyTotalBytes = 0;
  }

  // -- C3b history ----------------------------------------------------------

  setHistoryEnabled(enabled: boolean): void {
    this.historyEnabled = enabled;
    if (!enabled) {
      this.history = [];
      this.historyTotalBytes = 0;
    }
  }

  isHistoryEnabled(): boolean {
    return this.historyEnabled;
  }

  /** §8.19.5 Settings: item cap clamped to 1–50, total bytes user-settable. */
  setHistoryLimits(maxItems: number, maxTotalBytes: number): void {
    this.historyMaxItems = Math.min(50, Math.max(1, Math.floor(maxItems)));
    this.historyMaxTotalBytes = Math.max(1024, Math.floor(maxTotalBytes));
    this.evictOverflow();
  }

  historyLimits(): { maxItems: number; maxTotalBytes: number; } {
    return { maxItems: this.historyMaxItems, maxTotalBytes: this.historyMaxTotalBytes };
  }

  /** Outcome of the most recent write's history admission (non-blocking). */
  historyExclusion(): ClipboardHistoryExclusion {
    return this.lastHistoryExclusion;
  }

  /** Remove ONE entry (Delete key in the popup); false when index invalid. */
  removeHistoryEntry(index: number): boolean {
    const entry = this.history[index];
    if (!entry) return false;
    this.history.splice(index, 1);
    this.historyTotalBytes -= entry.bytes;
    return true;
  }

  historyEntries(): readonly EditorClipboardSession[] {
    return this.history.map((entry) => entry.session);
  }

  pasteFromHistory(index: number): EditorClipboardSession | null {
    // Pasting from history promotes the entry back to the live slot so the
    // regular paste path (and its plan) can be reused unchanged.
    const entry = this.history[index];
    if (!entry) return null;
    this.session = entry.session;
    return entry.session;
  }

  clearHistory(): void {
    this.history = [];
    this.historyTotalBytes = 0;
  }

  private recordHistory(session: EditorClipboardSession, eligible: boolean): void {
    if (!this.historyEnabled || !eligible) {
      this.lastHistoryExclusion = "history-disabled";
      return;
    }
    // UTF-16 length is the closest WebView proxy for the byte budget; the
    // conservative estimate keeps quota math from undercounting.
    const bytes = session.plainText.length * 2 + (session.segments?.reduce((sum, segment) => sum + segment.length * 2, 0) ?? 0);
    if (bytes > CLIPBOARD_HISTORY_MAX_ITEM_BYTES) {
      this.lastHistoryExclusion = "oversized-item";
      return;
    }
    this.lastHistoryExclusion = "recorded";
    const existing = this.history.findIndex((entry) => entry.session.plainText === session.plainText);
    if (existing >= 0) {
      const [moved] = this.history.splice(existing, 1);
      this.historyTotalBytes -= moved.bytes;
    }
    this.history.unshift({ session, bytes });
    this.historyTotalBytes += bytes;
    this.evictOverflow();
  }

  private evictOverflow(): void {
    while (
      this.history.length > 0
      && (this.history.length > this.historyMaxItems
        || this.historyTotalBytes > this.historyMaxTotalBytes)
    ) {
      const dropped = this.history.pop();
      if (dropped) this.historyTotalBytes -= dropped.bytes;
    }
  }
}
