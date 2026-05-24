/**
 * Parser for the Drawer Composer's `@reference` syntax.
 *
 * Supported forms:
 *   - `@terminal:last-50`    → 50 most-recent lines from the active terminal
 *   - `@terminal`            → defaults to last 50
 *   - `@file:/path/to/file`  → contents of the local file (truncated to 64KB)
 *   - `@file:./relative.log` → resolved relative to the active terminal's cwd
 *   - `@session:<id-or-name>` → metadata of the named session (host, user)
 *
 * The parser doesn't perform IO — it only extracts AttachmentRef objects from
 * the user's message. The Composer/store calls a resolver that turns refs
 * into terminal_context and structured attachments before dispatch.
 */

export type AttachmentRef =
  | { kind: "terminal"; lines: number }
  | { kind: "file"; path: string }
  | { kind: "session"; query: string };

export interface ParsedComposerInput {
  /** Original input minus the @ tokens (kept for the LLM to read). */
  message: string;
  attachments: AttachmentRef[];
}

const TOKEN_RE = /@(terminal|file|session)(?::([^\s]+))?/gi;

export function parseComposerInput(input: string): ParsedComposerInput {
  const attachments: AttachmentRef[] = [];
  let cleaned = input;

  for (const m of input.matchAll(TOKEN_RE)) {
    const kind = m[1].toLowerCase();
    const arg = m[2];
    if (kind === "terminal") {
      let lines = 50;
      if (arg) {
        const parsed = arg.replace(/^last[-_]?/i, "");
        const n = Number(parsed);
        if (Number.isFinite(n) && n > 0) lines = Math.min(2000, Math.round(n));
      }
      attachments.push({ kind: "terminal", lines });
    } else if (kind === "file") {
      if (arg) attachments.push({ kind: "file", path: arg });
    } else if (kind === "session") {
      if (arg) attachments.push({ kind: "session", query: arg });
    }
  }

  // Strip the @-tokens from the displayed message — the AI sees them as
  // attachments, not as raw `@terminal` text. We keep a humanized hint so
  // the user can see what got attached.
  cleaned = cleaned.replace(TOKEN_RE, "").replace(/\s+/g, " ").trim();

  return { message: cleaned, attachments };
}
