import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { visualColumnFor } from "./geometry";
import { MAX_OVERFLOW_COLUMNS, setVirtualOverflow, setVirtualOverflowRestore, virtualSpaceOverflowField } from "./overflow";
import { editorVirtualSpacePolicy } from "./policy";

/**
 * Place (or clear) a virtual caret at `head` with `overflow` columns past the
 * line end. Selection-only dispatch — never touches doc or history.
 */
export function setVirtualHead(
  view: EditorView,
  head: number,
  overflow: number,
  extend: boolean,
): void {
  const previous = view.state.field(virtualSpaceOverflowField, false) ?? new Map<number, number>();
  // Other carets keep both their positions and their overflow entries —
  // placing a virtual caret never silently collapses multi-caret state.
  const map = new Map(previous);
  map.delete(head);
  if (overflow > 0) map.set(head, Math.min(overflow, MAX_OVERFLOW_COLUMNS));
  const main = view.state.selection.main;
  const ranges = view.state.selection.ranges.map((range, index) => (
    index === view.state.selection.mainIndex
      ? (extend
        ? EditorSelection.range(main.anchor, head)
        : EditorSelection.cursor(head))
      : range
  ));
  view.dispatch({
    selection: EditorSelection.create(ranges, view.state.selection.mainIndex),
    effects: setVirtualOverflow.of(map),
    scrollIntoView: true,
  });
}

/**
 * End / Shift+End under an enabling policy: first press lands on the real
 * line end; presses while already AT the end walk deeper into the virtual
 * region one visual column at a time. Without the policy this defers to the
 * default keymap (returns false).
 */
export function virtualLineEndCommand(view: EditorView, extend: boolean): boolean {
  if (view.composing) return false;
  const policy = view.state.facet(editorVirtualSpacePolicy);
  if (!policy.afterLineEnd && !policy.atFileBottom) return false;
  const state = view.state;
  const anyAtEndOrVirtual = state.selection.ranges.some((range) => {
    const line = state.doc.lineAt(range.head);
    return range.head >= line.to;
  });
  if (!anyAtEndOrVirtual) return false;
  const previous = state.field(virtualSpaceOverflowField, false) ?? new Map<number, number>();
  const nextOverflow = new Map(previous);
  let changed = false;

  const ranges = state.selection.ranges.map((range) => {
    const headLine = state.doc.lineAt(range.head);
    const oldOverflow = previous.get(range.head) ?? 0;
    let targetHead = headLine.to;
    if (range.head >= headLine.to || oldOverflow > 0) {
      const isLastLine = headLine.number === state.doc.lines;
      const allowed = isLastLine ? policy.atFileBottom : policy.afterLineEnd;
      if (allowed) {
        const overflow = Math.min(oldOverflow + 1, MAX_OVERFLOW_COLUMNS);
        nextOverflow.set(headLine.to, overflow);
        changed = true;
      }
    } else {
      targetHead = headLine.to;
      changed = true;
    }
    if (!extend) return EditorSelection.cursor(targetHead);
    return EditorSelection.range(range.anchor, targetHead);
  });
  if (!changed) return false;

  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(nextOverflow),
    scrollIntoView: true,
  });
  return true;
}

/**
 * Backspace inside the virtual region shrinks the overflow WITHOUT touching
 * the document; at zero overflow it defers to the normal delete command.
 */
export function virtualBackspaceCommand(view: EditorView): boolean {
  if (view.composing) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const next = new Map(field);
  let touched = false;
  for (const range of view.state.selection.ranges) {
    const overflow = next.get(range.head);
    if (overflow == null) continue;
    touched = true;
    if (overflow - 1 <= 0) next.delete(range.head);
    else next.set(range.head, overflow - 1);
  }
  if (!touched) return false;
  view.dispatch({ effects: setVirtualOverflow.of(next) });
  return true;
}

/** Padding spaces that realize a virtual caret before a real insertion. */
export function paddingForOverflow(overflow: number): string {
  return overflow > 0 ? " ".repeat(overflow) : "";
}

/**
 * Typing consumption (§8.19.5): when a caret sits in the virtual region, the
 * first real insertion manufactures its padding spaces IN THE SAME
 * transaction. IME composition events are ignored (no padding while
 * composing); without overflow this defers to CodeMirror's default handler.
 * The consumed overflow is recorded for the undo restore (ED-AUDIT-002).
 */
export const virtualSpaceTypingHandler = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (view.composing || view.state.readOnly || !text) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const state = view.state;
  let anyPadding = false;
  const result = state.changeByRange((range) => {
    const padding = paddingForOverflow(field.get(range.head) ?? 0);
    if (padding) anyPadding = true;
    const insert = `${padding}${text}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(Math.min(range.from + insert.length, state.doc.length + insert.length)),
    };
  });
  if (!anyPadding) return false;
  view.dispatch({
    ...result,
    effects: setVirtualOverflowRestore.of(new Map(field)),
  });
  return true;
});

/**
 * Click past end-of-line (and below the last line under `atFileBottom`):
 * estimates the target visual column from the pixel overshoot and places a
 * virtual caret with a selection-only dispatch.
 */
export const virtualSpaceClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const mouse = event as MouseEvent;
    if (mouse.button !== 0) return false;
    // WebKitGTK's native pointer path can leave focus on BODY. This handler
    // may consume a click past EOL before later host handlers are reached.
    if (!view.hasFocus) view.focus();
    const policy = view.state.facet(editorVirtualSpacePolicy);
    if (!policy.afterLineEnd && !policy.atFileBottom) return false;
    const pos = view.posAtCoords({ x: mouse.clientX, y: mouse.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    if (pos < line.to) return false; // ordinary click inside the text
    const isLastLine = line.number === view.state.doc.lines;
    if (!(isLastLine ? policy.atFileBottom : policy.afterLineEnd)) return false;
    const endCoords = view.coordsAtPos(line.to);
    // Below the last line counts as overshoot too when the gate allows it.
    const belowFile = isLastLine && endCoords != null && mouse.clientY > endCoords.bottom + 2;
    const overshootPx = endCoords ? Math.max(0, mouse.clientX - endCoords.left) : 0;
    if (overshootPx < 4 && !belowFile) return false;
    const charWidth = Math.max(1, view.defaultCharacterWidth);
    const columns = Math.min(MAX_OVERFLOW_COLUMNS, Math.max(1, Math.round(overshootPx / charWidth)));
    setVirtualHead(view, line.to, columns, mouse.shiftKey);
    mouse.preventDefault();
    return true;
  },
});

export function virtualMoveLeftCommand(view: EditorView, extend: boolean): boolean {
  if (view.composing) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const state = view.state;
  const next = new Map(field);
  let changed = false;

  const ranges = state.selection.ranges.map((range) => {
    if (!extend && !range.empty) {
      next.delete(range.head);
      changed = true;
      return EditorSelection.cursor(range.from);
    }
    const overflow = next.get(range.head);
    let targetHead = range.head;
    if (overflow != null && overflow > 0) {
      changed = true;
      if (overflow - 1 <= 0) next.delete(range.head);
      else next.set(range.head, overflow - 1);
    } else {
      const line = state.doc.lineAt(range.head);
      if (range.head > line.from) {
        targetHead = range.head - 1;
        changed = true;
      }
    }

    if (!extend) return EditorSelection.cursor(targetHead);
    return EditorSelection.range(range.anchor, targetHead);
  });

  if (!changed) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(next),
    scrollIntoView: true,
  });
  return true;
}

export function virtualMoveRightCommand(view: EditorView, extend: boolean): boolean {
  if (view.composing) return false;
  const policy = view.state.facet(editorVirtualSpacePolicy);
  if (!policy.afterLineEnd && !policy.atFileBottom) return false;
  const state = view.state;
  const previous = state.field(virtualSpaceOverflowField, false) ?? new Map<number, number>();
  const anyAtEndOrVirtual = state.selection.ranges.some((range) => {
    const line = state.doc.lineAt(range.head);
    return range.head >= line.to || (previous.get(range.head) ?? 0) > 0;
  });
  if (!anyAtEndOrVirtual) return false;

  const next = new Map(previous);
  let changed = false;

  const ranges = state.selection.ranges.map((range) => {
    if (!extend && !range.empty) {
      next.delete(range.head);
      changed = true;
      return EditorSelection.cursor(range.to);
    }
    const headLine = state.doc.lineAt(range.head);
    const oldOverflow = previous.get(range.head) ?? 0;
    let targetHead = range.head;
    if (range.head >= headLine.to || oldOverflow > 0) {
      const isLastLine = headLine.number === state.doc.lines;
      const allowed = isLastLine ? policy.atFileBottom : policy.afterLineEnd;
      if (allowed) {
        const overflow = Math.min(oldOverflow + 1, MAX_OVERFLOW_COLUMNS);
        next.set(headLine.to, overflow);
        targetHead = headLine.to;
        changed = true;
      }
    } else {
      targetHead = Math.min(headLine.to, range.head + 1);
      changed = true;
    }

    if (!extend) return EditorSelection.cursor(targetHead);
    return EditorSelection.range(range.anchor, targetHead);
  });

  if (!changed) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(next),
    scrollIntoView: true,
  });
  return true;
}

export function virtualHomeCommand(view: EditorView, extend: boolean = false): boolean {
  if (view.composing) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const state = view.state;
  const ranges = state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head);
    const match = /^\s*/.exec(line.text);
    const indentCol = match ? match[0].length : 0;
    const target = range.head === line.from + indentCol ? line.from : line.from + indentCol;
    if (!extend) return EditorSelection.cursor(target);
    return EditorSelection.range(range.anchor, target);
  });
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(new Map()),
    scrollIntoView: true,
  });
  return true;
}

export function virtualDeleteCommand(view: EditorView): boolean {
  if (view.composing) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  return true;
}

export function virtualEnterCommand(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  const state = view.state;
  let anyPadding = false;
  const result = state.changeByRange((range) => {
    const padding = paddingForOverflow(field.get(range.head) ?? 0);
    if (padding) anyPadding = true;
    const insert = `${padding}\n`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  if (!anyPadding) return false;
  view.dispatch({
    ...result,
    effects: setVirtualOverflowRestore.of(new Map(field)),
  });
  return true;
}

export function virtualTabCommand(view: EditorView): boolean {
  if (view.composing) return false;
  const policy = view.state.facet(editorVirtualSpacePolicy);
  if (!policy.afterLineEnd && !policy.atFileBottom) return false;
  const field = view.state.field(virtualSpaceOverflowField, false);
  const state = view.state;
  const allAtEnd = state.selection.ranges.every((range) => range.head >= state.doc.lineAt(range.head).to);
  if (!allAtEnd && (!field || field.size === 0)) return false;

  const tabWidth = state.tabSize;
  const next = new Map(field ?? new Map());
  let changed = false;

  const ranges = state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head);
    const curOverflow = field?.get(range.head) ?? 0;
    const curVisual = visualColumnFor(line.text, line.length, tabWidth) + curOverflow;
    const delta = tabWidth - (curVisual % tabWidth) || tabWidth;
    const newOverflow = Math.min(curOverflow + delta, MAX_OVERFLOW_COLUMNS);
    next.set(line.to, newOverflow);
    changed = true;
    return EditorSelection.cursor(line.to);
  });

  if (!changed) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    effects: setVirtualOverflow.of(next),
  });
  return true;
}

export function virtualEscapeCommand(view: EditorView): boolean {
  const field = view.state.field(virtualSpaceOverflowField, false);
  if (!field || field.size === 0) return false;
  view.dispatch({
    effects: setVirtualOverflow.of(new Map()),
  });
  return true;
}
