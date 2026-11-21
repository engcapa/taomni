import { EditorSelection, type Extension, type Text } from "@codemirror/state";
import { crosshairCursor, EditorView, keymap, rectangularSelection } from "@codemirror/view";
import { formatColumnCell, type ColumnInsertSpec } from "../transforms/column";

export function buildRectangularSelection(
  doc: Text,
  anchorLineIdx: number,
  anchorCol: number,
  headLineIdx: number,
  headCol: number,
): EditorSelection {
  const startLine = Math.max(1, Math.min(anchorLineIdx, headLineIdx));
  const endLine = Math.min(doc.lines, Math.max(anchorLineIdx, headLineIdx));
  const minCol = Math.max(0, Math.min(anchorCol, headCol));
  const maxCol = Math.max(0, Math.max(anchorCol, headCol));

  const ranges = [];
  for (let ln = startLine; ln <= endLine; ln += 1) {
    const line = doc.line(ln);
    const from = Math.min(line.to, line.from + minCol);
    const to = Math.min(line.to, line.from + maxCol);
    ranges.push(EditorSelection.range(from, to));
  }
  return EditorSelection.create(ranges, headLineIdx >= anchorLineIdx ? ranges.length - 1 : 0);
}

function stepColumnSelection(view: EditorView, dLine: number, dCol: number): boolean {
  const { doc, selection } = view.state;
  const ranges = selection.ranges;
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const primary = selection.main;
  const headAtBottom = primary === last && (ranges.length === 1 || primary.head >= first.head);

  const anchorRange = headAtBottom ? first : last;
  const anchorLine = doc.lineAt(anchorRange.anchor).number;
  const anchorCol = anchorRange.anchor - doc.line(anchorLine).from;

  const headLine = doc.lineAt(primary.head).number;
  const headCol = primary.head - doc.line(headLine).from;

  const nextHeadLine = Math.max(1, Math.min(doc.lines, headLine + dLine));
  const nextHeadCol = Math.max(0, headCol + dCol);

  view.dispatch({
    selection: buildRectangularSelection(doc, anchorLine, anchorCol, nextHeadLine, nextHeadCol),
    scrollIntoView: true,
  });
  return true;
}

export function createColumnSelectionExtension(): Extension {
  return [
    rectangularSelection(),
    crosshairCursor(),
    keymap.of([
      { key: "Alt-Shift-ArrowDown", run: (v) => stepColumnSelection(v, 1, 0) },
      { key: "Alt-Shift-ArrowUp", run: (v) => stepColumnSelection(v, -1, 0) },
      { key: "Alt-Shift-ArrowRight", run: (v) => stepColumnSelection(v, 0, 1) },
      { key: "Alt-Shift-ArrowLeft", run: (v) => stepColumnSelection(v, 0, -1) },
    ]),
  ];
}

/**
 * Insert text or incremental number sequence across all rectangular ranges (or from active line).
 */
export function applyColumnEditorToView(view: EditorView, spec: ColumnInsertSpec): boolean {
  if (view.state.readOnly) return false;
  const { doc, selection } = view.state;
  const ranges = selection.ranges;
  if (ranges.length > 1) {
    const changes = ranges.map((range, idx) => ({
      from: range.from,
      to: range.to,
      insert: formatColumnCell(spec, idx, ranges.length),
    }));
    view.dispatch({ changes });
    return true;
  }

  const main = selection.main;
  const startLine = doc.lineAt(main.from);
  let endLineNum = doc.lineAt(main.to).number;
  if (main.to > main.from && doc.lineAt(main.to).from === main.to && endLineNum > startLine.number) {
    endLineNum -= 1;
  }
  const col = main.from - startLine.from;
  const totalRows = endLineNum - startLine.number + 1;
  const changes = [];
  for (let ln = startLine.number; ln <= endLineNum; ln += 1) {
    const line = doc.line(ln);
    const cell = formatColumnCell(spec, ln - startLine.number, totalRows);
    const pad = line.length < col ? " ".repeat(col - line.length) : "";
    const pos = Math.min(line.to, line.from + col);
    changes.push({ from: pos, to: pos, insert: pad + cell });
  }
  view.dispatch({ changes });
  return true;
}

/** Paste rectangular clipboard text line-by-line across column ranges when shapes match. */
export function applyColumnPasteToView(view: EditorView, clipText: string): boolean {
  if (view.state.readOnly) return false;
  const clipLines = clipText.replace(/\r\n/g, "\n").split("\n");
  const { doc, selection } = view.state;
  if (selection.ranges.length > 1) {
    const changes = selection.ranges.map((r, i) => ({
      from: r.from,
      to: r.to,
      insert: clipLines[i % clipLines.length] ?? "",
    }));
    view.dispatch({ changes });
    return true;
  }

  const startLine = doc.lineAt(selection.main.from);
  const col = selection.main.from - startLine.from;
  const changes = [];
  for (let i = 0; i < clipLines.length; i += 1) {
    const targetLn = startLine.number + i;
    if (targetLn <= doc.lines) {
      const line = doc.line(targetLn);
      const pad = line.length < col ? " ".repeat(col - line.length) : "";
      const pos = Math.min(line.to, line.from + col);
      changes.push({ from: pos, to: pos, insert: pad + clipLines[i] });
    }
  }
  if (changes.length > 0) view.dispatch({ changes });
  return true;
}
