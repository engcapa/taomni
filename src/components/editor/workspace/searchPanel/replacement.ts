import { RegExpCursor, SearchQuery, replaceAll, replaceNext } from "@codemirror/search";
import { EditorView } from "@codemirror/view";

export type CasingStyle = "upper" | "lower" | "title" | "camel" | "pascal" | "other";

export function detectCasing(text: string): CasingStyle {
  if (!text) return "other";
  if (text === text.toUpperCase() && text !== text.toLowerCase()) return "upper";
  if (text === text.toLowerCase() && text !== text.toUpperCase()) return "lower";
  if (/^[A-Z][a-z0-9]*$/.test(text)) return "title";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(text) && /[a-z]/.test(text) && /[A-Z]/.test(text.slice(1))) return "pascal";
  if (/^[a-z][a-zA-Z0-9]*$/.test(text) && /[A-Z]/.test(text)) return "camel";
  return "other";
}

export function applyPreserveCase(originalMatch: string, replacement: string): string {
  if (!originalMatch || !replacement) return replacement;
  const casing = detectCasing(originalMatch);
  switch (casing) {
    case "upper":
      return replacement.toUpperCase();
    case "lower":
      return replacement.toLowerCase();
    case "title":
      return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
    case "pascal":
      return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    case "camel":
      return replacement.charAt(0).toLowerCase() + replacement.slice(1);
    default:
      return replacement;
  }
}

export function unquoteReplacement(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_match, character: string) => {
    if (character === "n") return "\n";
    if (character === "r") return "\r";
    if (character === "t") return "\t";
    return "\\";
  });
}

export function expandRegexpReplacement(replacement: string, match: RegExpExecArray): string {
  return unquoteReplacement(replacement).replace(/\$([$&]|\d+)/g, (token, reference: string) => {
    if (reference === "&") return match[0] ?? "";
    if (reference === "$") return "$";

    // Match CodeMirror's replacement rule: prefer the longest valid group
    // prefix so `$10` means group 10 when it exists, otherwise group 1 + `0`.
    for (let length = reference.length; length > 0; length -= 1) {
      const group = Number(reference.slice(0, length));
      if (group > 0 && group < match.length) {
        return `${match[group] ?? ""}${reference.slice(length)}`;
      }
    }
    return token;
  });
}

export function replacementForMatch(
  view: EditorView,
  query: SearchQuery,
  from: number,
  to: number,
): string {
  if (!query.regexp) return unquoteReplacement(query.replace);

  // SearchQuery.getCursor intentionally exposes only ranges. Re-run the same
  // pattern through the public RegExpCursor to retain capture groups for the
  // exact range selected by the query, including multiline expressions.
  const cursor = new RegExpCursor(view.state.doc, query.search, {
    ignoreCase: !query.caseSensitive,
  });
  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    if (item.value.from === from && item.value.to === to) {
      return expandRegexpReplacement(query.replace, item.value.match);
    }
  }

  // The range came from SearchQuery, so this is only a defensive fallback for
  // a future CodeMirror cursor mismatch. It preserves the literal token text.
  return unquoteReplacement(query.replace);
}

export function replaceNextPreserveCase(
  view: EditorView,
  query: SearchQuery,
  preserveCase: boolean,
): boolean {
  if (view.state.readOnly || !query.valid || !query.search) return false;
  if (!preserveCase) return replaceNext(view);

  const sel = view.state.selection.main;
  const cursor = query.getCursor(view.state);
  let targetMatch: { from: number; to: number; } | null = null;
  let nextMatch: { from: number; to: number; } | null = null;

  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    if (item.value.from === sel.from && item.value.to === sel.to) {
      targetMatch = item.value;
      const next = cursor.next();
      if (!next.done) nextMatch = next.value;
      break;
    } else if (item.value.from >= sel.to && !targetMatch) {
      targetMatch = item.value;
      break;
    }
  }

  // If no match found at or after current selection, wrap around to first match
  if (!targetMatch) {
    const wrapCursor = query.getCursor(view.state);
    const first = wrapCursor.next();
    if (!first.done) targetMatch = first.value;
  }

  if (!targetMatch) return false;

  const matchedText = view.state.sliceDoc(targetMatch.from, targetMatch.to);
  const replacement = applyPreserveCase(
    matchedText,
    replacementForMatch(view, query, targetMatch.from, targetMatch.to),
  );

  view.dispatch({
    changes: { from: targetMatch.from, to: targetMatch.to, insert: replacement },
    selection: { anchor: targetMatch.from + replacement.length },
    scrollIntoView: true,
    userEvent: "input.replace",
  });

  // After replacing, advance selection to the next match if found
  if (!nextMatch) {
    const freshCursor = query.getCursor(view.state, targetMatch.from + replacement.length);
    const next = freshCursor.next();
    if (!next.done) {
      view.dispatch({
        selection: { anchor: next.value.from, head: next.value.to },
        scrollIntoView: true,
      });
    }
  } else {
    const offset = replacement.length - matchedText.length;
    view.dispatch({
      selection: { anchor: nextMatch.from + offset, head: nextMatch.to + offset },
      scrollIntoView: true,
    });
  }

  return true;
}

export function replaceAllPreserveCase(
  view: EditorView,
  query: SearchQuery,
  preserveCase: boolean,
  /** ED-PARITY-012 DEC-012-04: `from:to` keys of matches the user excluded. */
  excluded: ReadonlySet<string> = new Set(),
): boolean {
  if (view.state.readOnly || !query.valid || !query.search) return false;
  if (!preserveCase && excluded.size === 0) return replaceAll(view);

  const cursor = query.getCursor(view.state);
  const changes: Array<{ from: number; to: number; insert: string; }> = [];

  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    if (excluded.has(`${item.value.from}:${item.value.to}`)) continue;
    const matchedText = view.state.sliceDoc(item.value.from, item.value.to);
    const rawReplacement = replacementForMatch(view, query, item.value.from, item.value.to);
    const replacement = preserveCase ? applyPreserveCase(matchedText, rawReplacement) : rawReplacement;
    changes.push({ from: item.value.from, to: item.value.to, insert: replacement });
  }

  if (changes.length === 0) return false;

  view.dispatch({
    changes,
    userEvent: "input.replace.all",
  });

  return true;
}
