// Keys used while the native command/paste field is focused edit that draft,
// not a different line on the remote shell. Other keys (Tab, Esc, ^C, ↑/↓…)
// remain PTY keys. This keeps symbols and caret movement useful with phone IMEs.
export interface DraftEdit { value: string; start: number; end: number }

export function editDraft(value: string, start: number, end: number, key: string): DraftEdit | null {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prev = start - (Array.from(before).at(-1)?.length ?? 0);
  const next = end + (Array.from(after)[0]?.length ?? 0);
  const lineStart = before.lastIndexOf("\n") + 1;
  const nextBreak = value.indexOf("\n", end);
  const lineEnd = nextBreak < 0 ? value.length : nextBreak;
  const wordStart = before.replace(/\S+\s*$/, "").length;
  const wordEnd = end + (after.match(/^\s*\S+/)?.[0].length ?? 0);
  const caret = (position: number): DraftEdit => ({ value, start: position, end: position });
  const replace = (from: number, to: number, text = ""): DraftEdit => ({ value: value.slice(0, from) + text + value.slice(to), start: from + text.length, end: from + text.length });
  switch (key) {
    case "\x1b[D": case "\x1bOD": return caret(start !== end ? start : prev);
    case "\x1b[C": case "\x1bOC": return caret(start !== end ? end : next);
    case "\x1b[1;5D": case "\x1b[1;3D": return caret(wordStart);
    case "\x1b[1;5C": case "\x1b[1;3C": return caret(wordEnd);
    case "\x01": case "\x1b[H": case "\x1bOH": return caret(lineStart);
    case "\x05": case "\x1b[F": case "\x1bOF": return caret(lineEnd);
    case "\x7f": return replace(start !== end ? start : prev, end);
    case "\x17": return replace(start !== end ? start : wordStart, end);
    case "\x15": return replace(lineStart, end);
    case "\x0b": return replace(start, lineEnd);
    default: return /^[\x20-\x7e]+$/.test(key) ? replace(start, end, key) : null;
  }
}
