import { Change, diff } from "@codemirror/merge";

export type WhitespaceMode = "none" | "trailing" | "all";

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
