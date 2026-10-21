import { EditorSelection, type ChangeSpec, type StateCommand } from "@codemirror/state";
import { type SortLinesOptions } from "./types";

export const toggleCase: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const changes = [];
  const ranges = [];

  for (const range of state.selection.ranges) {
    let from = range.from;
    let to = range.to;

    if (from === to) {
      const word = state.wordAt(from);
      if (!word) continue;
      from = word.from;
      to = word.to;
    }

    const text = state.sliceDoc(from, to);
    if (!text) continue;
    const isAllUpper = text === text.toUpperCase() && text !== text.toLowerCase();
    const replacement = isAllUpper ? text.toLowerCase() : text.toUpperCase();

    changes.push({ from, to, insert: replacement });
    ranges.push(EditorSelection.range(from, from + replacement.length));
  }

  if (changes.length === 0) return false;

  dispatch(
    state.update({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      userEvent: "input.toggleCase",
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Join selected lines or current line with the next line (IDEA Ctrl+Shift+J),
 * collapsing intervening whitespace. Multi-range aware.
 */
export const joinLines: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;

  const changes: ChangeSpec[] = [];
  const processedLines = new Set<number>();

  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);

    const fromLineNum = startLine.number;
    const toLineNum = range.empty ? fromLineNum : endLine.number;

    for (let l = fromLineNum; l <= toLineNum; l++) {
      if (l >= state.doc.lines) break;
      if (processedLines.has(l)) continue;
      processedLines.add(l);

      const line = state.doc.line(l);
      const nextLine = state.doc.line(l + 1);
      const nextTrimmedStart = nextLine.from + (nextLine.text.match(/^\s*/)?.[0].length ?? 0);
      const deleteFrom = line.to;
      const deleteTo = nextTrimmedStart;

      const needsSpace = line.length > 0 && !/\s$/.test(line.text) && nextLine.length > 0;
      const insert = needsSpace ? " " : "";

      changes.push({ from: deleteFrom, to: deleteTo, insert });
    }
  }

  if (changes.length === 0) return false;

  dispatch(
    state.update({
      changes,
      userEvent: "delete.joinLines",
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Sort lines in selection alphabetically. Multi-range aware.
 */
export function sortLinesWithOptions(options: SortLinesOptions = {}): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;

    const changes: ChangeSpec[] = [];

    for (const range of state.selection.ranges) {
      if (range.empty) continue;
      const startLine = state.doc.lineAt(range.from);
      const endLine = state.doc.lineAt(range.to);
      if (startLine.number === endLine.number) continue;

      const lines: string[] = [];
      for (let i = startLine.number; i <= endLine.number; i++) {
        lines.push(state.doc.line(i).text);
      }

      const sorted = [...lines].sort((a, b) => {
        let cmp = 0;
        if (options.natural) {
          cmp = a.localeCompare(b, undefined, { numeric: true, sensitivity: options.caseSensitive ? "variant" : "base" });
        } else if (options.caseSensitive) {
          cmp = a < b ? -1 : a > b ? 1 : 0;
        } else {
          cmp = a.localeCompare(b, undefined, { sensitivity: "base" });
        }
        return options.descending ? -cmp : cmp;
      });

      const newText = sorted.join("\n");
      changes.push({ from: startLine.from, to: endLine.to, insert: newText });
    }

    if (changes.length === 0) return false;

    dispatch(
      state.update({
        changes,
        userEvent: "edit.sortLines",
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

export const sortLines: StateCommand = sortLinesWithOptions({});

/**
 * Reverse lines in selection. Multi-range aware.
 */
export const reverseLines: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;

  const changes: ChangeSpec[] = [];

  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    if (startLine.number === endLine.number) continue;

    const lines: string[] = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
      lines.push(state.doc.line(i).text);
    }

    const reversed = [...lines].reverse();
    const newText = reversed.join("\n");
    changes.push({ from: startLine.from, to: endLine.to, insert: newText });
  }

  if (changes.length === 0) return false;

  dispatch(
    state.update({
      changes,
      userEvent: "edit.reverseLines",
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Transpose current line with next line, or transpose characters at cursor (IDEA Transpose).
 */
export const transposeLines: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);

  if (line.number < state.doc.lines) {
    // Transpose lines
    const nextLine = state.doc.line(line.number + 1);
    const text1 = line.text;
    const text2 = nextLine.text;
    const newText = `${text2}\n${text1}`;

    dispatch(
      state.update({
        changes: { from: line.from, to: nextLine.to, insert: newText },
        selection: { anchor: line.from + text2.length + 1 + (main.head - line.from) },
        userEvent: "edit.transpose",
        scrollIntoView: true,
      }),
    );
    return true;
  }
  return false;
};

/**
 * Tab Jump-Out: when cursor is right before a closing bracket/quote, Tab jumps past it.
 */
export const tabJumpOut: StateCommand = ({ state, dispatch }) => {
  const main = state.selection.main;
  if (!main.empty) return false;
  const pos = main.head;
  if (pos >= state.doc.length) return false;

  const nextChar = state.sliceDoc(pos, pos + 1);
  if ([")", "]", "}", '"', "'", "`", ";", ">"].includes(nextChar)) {
    dispatch(
      state.update({
        selection: { anchor: pos + 1 },
        scrollIntoView: true,
      }),
    );
    return true;
  }
  return false;
};

/**
 * Unwrap / Remove enclosing syntax constructs (parentheses, braces, brackets, quotes).
 */
export const unwrapRemove: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const main = state.selection.main;
  const pos = main.head;

  // Search around cursor for enclosing quotes or brackets
  const line = state.doc.lineAt(pos);
  const lineText = line.text;
  const col = pos - line.from;

  // Check quotes or parens surrounding cursor
  for (const [openChar, closeChar] of [["(", ")"], ["[", "]"], ["{", "}"], ['"', '"'], ["'", "'"], ["`", "`"]]) {
    const lastOpen = lineText.lastIndexOf(openChar, col - 1);
    const nextClose = lineText.indexOf(closeChar, col);

    if (lastOpen !== -1 && nextClose !== -1 && lastOpen < nextClose) {
      const openPos = line.from + lastOpen;
      const closePos = line.from + nextClose;

      dispatch(
        state.update({
          changes: [
            { from: openPos, to: openPos + 1, insert: "" },
            { from: closePos, to: closePos + 1, insert: "" },
          ],
          userEvent: "delete.unwrap",
          scrollIntoView: true,
        }),
      );
      return true;
    }
  }

  return false;
};
