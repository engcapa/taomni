import { Change, diff } from "@codemirror/merge";

export type WhitespaceMode = "none" | "trailing" | "all";

export type LineEndingStyle = "LF" | "CRLF" | "CR" | "mixed" | "none";

interface Normalized {
  norm: string;
  // map[k] = index in the original string of the k-th kept character
  map: number[];
}

/**
 * Drop whitespace characters according to `mode`, keeping a map back to the
 * original character offsets. Newlines are always preserved so line alignment
 * stays intact.
 */
export function normalizeWhitespace(text: string, mode: WhitespaceMode): Normalized {
  if (mode === "none") {
    const map = new Array<number>(text.length);
    for (let i = 0; i < text.length; i += 1) map[i] = i;
    return { norm: text, map };
  }
  const kept: string[] = [];
  const map: number[] = [];
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const ch = text[i];
    let drop = false;
    if (ch === " " || ch === "\t") {
      if (mode === "all") {
        drop = true;
      } else {
        // trailing: drop only when the rest of the line is whitespace
        let j = i;
        while (j < n && (text[j] === " " || text[j] === "\t")) j += 1;
        drop = j >= n || text[j] === "\n";
      }
    }
    if (!drop) {
      kept.push(ch);
      map.push(i);
    }
  }
  return { norm: kept.join(""), map };
}

function mapPos(norm: Normalized, originalLength: number, pos: number): number {
  if (pos <= 0) return 0;
  if (pos >= norm.map.length) return originalLength;
  return norm.map[pos];
}

/** Strip CR so LF and CRLF (and bare CR) compare as content-equal. */
export function stripLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function detectLineEndingStyle(text: string): LineEndingStyle {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\r") {
      if (text[i + 1] === "\n") {
        crlf += 1;
        i += 1;
      } else {
        cr += 1;
      }
    } else if (ch === "\n") {
      lf += 1;
    }
  }
  const kinds = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  if (crlf > 0) return "CRLF";
  if (cr > 0) return "CR";
  return "LF";
}

/**
 * True when old/new differ only by line-ending bytes (and maybe identical empty).
 * Content after normalizing \r\n / \r → \n is equal, but the raw strings are not.
 */
export function isEolOnlyDiff(oldText: string | null | undefined, newText: string | null | undefined): boolean {
  if (oldText == null || newText == null) return false;
  if (oldText === newText) return false;
  return stripLineEndings(oldText) === stripLineEndings(newText);
}

export function eolOnlyDiffLabel(oldText: string, newText: string): string {
  const from = detectLineEndingStyle(oldText);
  const to = detectLineEndingStyle(newText);
  if (from === to) {
    return "Line endings differ only (same style reported; mixed/offset CR/LF bytes).";
  }
  return `Line endings only: ${from} → ${to}. Content is identical after normalizing newlines.`;
}

/**
 * Rewrite `text` so its line endings match `target` (typically HEAD / old side).
 * Used to clear phantom CRLF changes from the worktree.
 */
export function applyLineEndingStyle(text: string, target: LineEndingStyle): string {
  const lf = stripLineEndings(text);
  if (target === "CRLF") return lf.replace(/\n/g, "\r\n");
  if (target === "CR") return lf.replace(/\n/g, "\r");
  // LF, none, mixed → prefer LF for a clean worktree
  return lf;
}

/**
 * Normalize worktree text to match the old side's line-ending style when the
 * pair is EOL-only. Returns null when not applicable.
 */
export function normalizeWorktreeToMatchHead(
  oldText: string | null | undefined,
  newText: string | null | undefined,
): string | null {
  if (!isEolOnlyDiff(oldText, newText) || oldText == null || newText == null) return null;
  const style = detectLineEndingStyle(oldText);
  const normalized = applyLineEndingStyle(newText, style === "mixed" || style === "none" ? "LF" : style);
  // Prefer exact match to old when content-equal after strip
  if (stripLineEndings(normalized) === stripLineEndings(oldText)) {
    // Rebuild from old content with old's exact bytes when possible
    if (stripLineEndings(oldText) === stripLineEndings(newText)) {
      return oldText;
    }
  }
  return normalized;
}

/**
 * Build a diff `override` for @codemirror/merge that ignores whitespace per
 * `mode`. The diff runs on whitespace-stripped copies, then change offsets are
 * mapped back to the original documents so the editors still display real text.
 * Returns `undefined` for "none" (use the package default).
 */
export function buildDiffOverride(
  mode: WhitespaceMode,
): ((a: string, b: string) => readonly Change[]) | undefined {
  if (mode === "none") return undefined;
  return (a: string, b: string) => {
    const na = normalizeWhitespace(a, mode);
    const nb = normalizeWhitespace(b, mode);
    const changes = diff(na.norm, nb.norm, { scanLimit: 500 });
    return changes.map(
      (c) =>
        new Change(
          mapPos(na, a.length, c.fromA),
          mapPos(na, a.length, c.toA),
          mapPos(nb, b.length, c.fromB),
          mapPos(nb, b.length, c.toB),
        ),
    );
  };
}
