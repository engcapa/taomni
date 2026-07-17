import type { Language } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";

export interface SyntaxSpan {
  /** UTF-16 offsets into the source string. */
  from: number;
  to: number;
  className: string;
}

export interface LineRenderSpan {
  text: string;
  /** Space-separated tok-* classes from Lezer classHighlighter. */
  className?: string;
  /** Keyword hit from the search match. */
  hit?: boolean;
}

const languageCache = new Map<string, Promise<Language | null>>();

function extensionKey(path: string): string {
  const name = path.toLowerCase().replace(/\\/g, "/");
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
}

/**
 * Resolve a CodeMirror Language for a file path (by extension). Results are
 * cached per extension so Find-in-Files rows share the same grammar instance.
 */
export function languageForSearchPath(path: string): Promise<Language | null> {
  const key = extensionKey(path);
  if (!key) return Promise.resolve(null);
  let pending = languageCache.get(key);
  if (!pending) {
    pending = loadLanguage(key).catch(() => null);
    languageCache.set(key, pending);
  }
  return pending;
}

async function loadLanguage(ext: string): Promise<Language | null> {
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: true }).language;
    }
    case "ts": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: true }).language;
    }
    case "tsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: true, typescript: true }).language;
    }
    case "json":
    case "jsonc": {
      const { json } = await import("@codemirror/lang-json");
      return json().language;
    }
    case "py":
    case "pyi": {
      const { python } = await import("@codemirror/lang-python");
      return python().language;
    }
    case "rs": {
      const { rust } = await import("@codemirror/lang-rust");
      return rust().language;
    }
    case "java": {
      const { java } = await import("@codemirror/lang-java");
      return java().language;
    }
    case "go": {
      const { go } = await import("@codemirror/lang-go");
      return go().language;
    }
    case "css":
    case "scss":
    case "less": {
      const { css } = await import("@codemirror/lang-css");
      return css().language;
    }
    case "html":
    case "htm":
    case "vue":
    case "svelte": {
      const { html } = await import("@codemirror/lang-html");
      return html().language;
    }
    case "md":
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown().language;
    }
    case "xml":
    case "svg":
    case "xaml":
    case "plist": {
      const { xml } = await import("@codemirror/lang-xml");
      return xml().language;
    }
    case "yaml":
    case "yml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml().language;
    }
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hxx": {
      const { cpp } = await import("@codemirror/lang-cpp");
      return cpp().language;
    }
    case "php": {
      const { php } = await import("@codemirror/lang-php");
      return php().language;
    }
    case "sql": {
      const { sql } = await import("@codemirror/lang-sql");
      return sql().language;
    }
    default:
      return null;
  }
}

/** Collect classHighlighter spans for a single line of source. */
export function syntaxSpansForLine(text: string, language: Language | null): SyntaxSpan[] {
  if (!language || !text) return [];
  try {
    const tree = language.parser.parse(text);
    const spans: SyntaxSpan[] = [];
    highlightTree(tree, classHighlighter, (from, to, classes) => {
      if (to > from && classes) spans.push({ from, to, className: classes });
    });
    return spans;
  } catch {
    return [];
  }
}

/** Convert code-point indices into UTF-16 string indices. */
export function codePointRangeToUtf16(
  text: string,
  startCp: number,
  endCp: number,
): { start: number; end: number } {
  const chars = Array.from(text);
  const startSafe = Math.max(0, Math.min(startCp, chars.length));
  const endSafe = Math.max(startSafe, Math.min(endCp, chars.length));
  const before = chars.slice(0, startSafe).join("");
  const mid = chars.slice(startSafe, endSafe).join("");
  return { start: before.length, end: before.length + mid.length };
}

/**
 * Merge syntax token ranges with a single hit range into ordered display spans.
 * Offsets for `syntax` are UTF-16; hitStart/hitEnd are code-point indices into `text`.
 */
export function buildLineRenderSpans(
  text: string,
  hitStartCp: number,
  hitEndCp: number,
  syntax: SyntaxSpan[],
): LineRenderSpan[] {
  if (!text) return [];
  const { start: hitFrom, end: hitTo } = codePointRangeToUtf16(text, hitStartCp, hitEndCp);
  const bounds = new Set<number>([0, text.length, hitFrom, hitTo]);
  for (const span of syntax) {
    bounds.add(Math.max(0, Math.min(span.from, text.length)));
    bounds.add(Math.max(0, Math.min(span.to, text.length)));
  }
  const points = [...bounds].sort((a, b) => a - b);
  const activeClassAt = (index: number): string | undefined => {
    // Last covering span wins (highlightTree emits nested/overlapping tags).
    let found: string | undefined;
    for (const span of syntax) {
      if (span.from <= index && index < span.to) found = span.className;
    }
    return found;
  };

  const result: LineRenderSpan[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    if (to <= from) continue;
    const piece = text.slice(from, to);
    if (!piece) continue;
    const hit = from >= hitFrom && to <= hitTo && hitTo > hitFrom;
    const className = activeClassAt(from);
    const last = result[result.length - 1];
    if (last && last.hit === hit && last.className === className) {
      last.text += piece;
    } else {
      result.push({ text: piece, className, hit });
    }
  }
  return result;
}

export function highlightSearchLine(
  text: string,
  hitStartCp: number,
  hitEndCp: number,
  language: Language | null,
): LineRenderSpan[] {
  return buildLineRenderSpans(text, hitStartCp, hitEndCp, syntaxSpansForLine(text, language));
}

/** Test helper: drop cached language promises. */
export function clearSearchLineHighlightCache(): void {
  languageCache.clear();
}
