export interface NoteUrlMatch {
  raw: string;
  url: string;
  start: number;
  end: number;
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION = /[.,!?;:，。！？；：'"”’)\]}]+$/;

function trimUrlToken(value: string): string {
  return value.replace(TRAILING_URL_PUNCTUATION, "");
}

export function normalizeNoteUrl(value: string): string | null {
  const trimmed = trimUrlToken(value.trim());
  if (!trimmed) return null;
  const candidate = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function extractNoteUrls(text: string): NoteUrlMatch[] {
  const matches: NoteUrlMatch[] = [];
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const token = trimUrlToken(match[0]);
    const url = normalizeNoteUrl(token);
    if (!url || match.index === undefined) continue;
    matches.push({
      raw: token,
      url,
      start: match.index,
      end: match.index + token.length,
    });
  }
  return matches;
}

export function findNoteUrlAtIndex(text: string, index: number): NoteUrlMatch | null {
  for (const match of extractNoteUrls(text)) {
    if (index >= match.start && index <= match.end) return match;
  }
  return null;
}
