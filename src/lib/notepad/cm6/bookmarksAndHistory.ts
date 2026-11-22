import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";

export const setBookmarksEffect = StateEffect.define<number[]>();
export const markHistoryBaselineEffect = StateEffect.define<string[]>();
export const clearChangeHistoryEffect = StateEffect.define<string[]>();
export const setShowChangeHistoryEffect = StateEffect.define<boolean>();

class BookmarkMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const dot = document.createElement("span");
    dot.className = "np-bm-marker";
    dot.title = "Bookmark";
    return dot;
  }
}

class HistoryMarker extends GutterMarker {
  constructor(private readonly kind: "modified" | "saved") {
    super();
  }
  eq(other: HistoryMarker): boolean {
    return this.kind === other.kind;
  }
  toDOM(): HTMLElement {
    const bar = document.createElement("span");
    bar.className = `np-ch-marker np-ch-${this.kind}`;
    return bar;
  }
}

const bookmarkIcon = new BookmarkMarker();
const modifiedBar = new HistoryMarker("modified");
const savedBar = new HistoryMarker("saved");

export const bookmarkStateField = StateField.define<Set<number>>({
  create: () => new Set<number>(),
  update(bookmarks, tr) {
    for (const e of tr.effects) {
      if (e.is(setBookmarksEffect)) return new Set(e.value.filter((n) => n >= 0));
    }
    if (!tr.docChanged || bookmarks.size === 0) return bookmarks;
    // Remap line positions across document edits cleanly
    const mapped = new Set<number>();
    const prevDoc = tr.startState.doc;
    const nextDoc = tr.state.doc;
    for (const ln0 of bookmarks) {
      const lineNum = ln0 + 1;
      if (lineNum <= prevDoc.lines) {
        const oldPos = prevDoc.line(lineNum).from;
        const newPos = tr.changes.mapPos(oldPos, 1);
        mapped.add(nextDoc.lineAt(Math.min(newPos, nextDoc.length)).number - 1);
      }
    }
    return mapped;
  },
});

interface ChangeHistoryState {
  baseline: string[];
  savedTouched: Set<number>;
  show: boolean;
}

export const changeHistoryField = StateField.define<ChangeHistoryState>({
  create: () => ({ baseline: [], savedTouched: new Set<number>(), show: true }),
  update(state, tr) {
    let next = state;
    for (const e of tr.effects) {
      if (e.is(clearChangeHistoryEffect)) {
        next = { ...next, baseline: e.value, savedTouched: new Set<number>() };
      } else if (e.is(markHistoryBaselineEffect)) {
        const nextSaved = new Set(next.savedTouched);
        const curLines = tr.state.doc.toString().split("\n");
        for (let i = 0; i < curLines.length; i += 1) {
          if (next.baseline[i] !== undefined && next.baseline[i] !== curLines[i]) {
            nextSaved.add(i);
          }
        }
        next = { ...next, baseline: e.value, savedTouched: nextSaved };
      } else if (e.is(setShowChangeHistoryEffect)) {
        next = { ...next, show: e.value };
      }
    }
    return next;
  },
});

export function createBookmarksAndHistoryExtension(options: {
  initialBookmarks?: number[];
  initialBaseline?: string[];
  showChangeHistory?: boolean;
  onToggleBookmark?: (lineZeroBased: number) => void;
}): Extension {
  const fields: Extension[] = [
    bookmarkStateField.init(() => new Set(options.initialBookmarks ?? [])),
    changeHistoryField.init(() => ({
      baseline: options.initialBaseline ?? [],
      savedTouched: new Set<number>(),
      show: options.showChangeHistory !== false,
    })),
  ];

  const bmGutter = gutter({
    class: "np-bm-gutter",
    lineMarker(view, line) {
      const ln0 = view.state.doc.lineAt(line.from).number - 1;
      return view.state.field(bookmarkStateField).has(ln0) ? bookmarkIcon : null;
    },
    lineMarkerChange: (update) =>
      update.startState.field(bookmarkStateField) !== update.state.field(bookmarkStateField),
    domEventHandlers: {
      mousedown(view, line) {
        const ln0 = view.state.doc.lineAt(line.from).number - 1;
        options.onToggleBookmark?.(ln0);
        return true;
      },
    },
  });

  const histGutter = gutter({
    class: "np-ch-gutter",
    lineMarker(view, line) {
      const chState = view.state.field(changeHistoryField);
      if (!chState.show || chState.baseline.length === 0) return null;
      const lineObj = view.state.doc.lineAt(line.from);
      const ln0 = lineObj.number - 1;
      const currentText = lineObj.text;
      if (chState.baseline[ln0] !== currentText) return modifiedBar;
      if (chState.savedTouched.has(ln0)) return savedBar;
      return null;
    },
    lineMarkerChange: (update) =>
      update.docChanged ||
      update.startState.field(changeHistoryField) !== update.state.field(changeHistoryField),
  });

  return [...fields, bmGutter, histGutter];
}

export function nextBookmarkPos(doc: Text, bookmarks: number[], currentLine0: number, backward: boolean): number | null {
  if (bookmarks.length === 0) return null;
  const sorted = [...new Set(bookmarks)].filter((n) => n >= 0 && n < doc.lines).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  let target: number;
  if (backward) {
    const prev = [...sorted].reverse().find((n) => n < currentLine0);
    target = prev ?? sorted[sorted.length - 1];
  } else {
    const next = sorted.find((n) => n > currentLine0);
    target = next ?? sorted[0];
  }
  return doc.line(target + 1).from;
}

export function applyBookmarkLinesOp(
  text: string,
  bookmarks: number[],
  mode: "copy" | "cut" | "removeBookmarked" | "removeUnmarked" | "inverse",
): { nextText: string; extractedText: string; nextBookmarks: number[] } {
  const lines = text.split("\n");
  const markSet = new Set(bookmarks.filter((n) => n >= 0 && n < lines.length));
  if (mode === "inverse") {
    const nextBookmarks: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!markSet.has(i)) nextBookmarks.push(i);
    }
    return { nextText: text, extractedText: "", nextBookmarks };
  }
  const picked = lines.filter((_, i) => markSet.has(i)).join("\n");
  if (mode === "copy") {
    return { nextText: text, extractedText: picked, nextBookmarks: bookmarks };
  }
  const kept =
    mode === "removeUnmarked"
      ? lines.filter((_, i) => markSet.has(i))
      : lines.filter((_, i) => !markSet.has(i));
  return {
    nextText: kept.join("\n"),
    extractedText: mode === "cut" ? picked : "",
    nextBookmarks: mode === "removeUnmarked" ? kept.map((_, idx) => idx) : [],
  };
}
