import type { EditorState } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MAX_OVERFLOW_COLUMNS, virtualOverflowAt } from "./overflow";
import { editorVirtualSpacePolicy } from "./policy";
import { visualColumnFor } from "./columns";


/**
 * §8.19.5 Virtual Space. IDEA keeps carets BEYOND the end of a line (and
 * below the last line) without touching the document; padding spaces are
 * only manufactured when content is actually inserted. Model:
 *
 *   - The caret's real offset stays clamped at the legal document position
 *     (CodeMirror invariant).
 *   - `virtualSpaceOverflowField` records, per selection head, how many
 *     VISUAL columns past the line end the caret sits (`overflow`).
 *   - Navigation (End / Shift+End repeats, click past EOL) writes overflow
 *     with a selection-only dispatch: no doc change, no history entry.
 *   - Real inserts (typing via the input handler, paste plans) consume the
 *     overflow by manufacturing the exact padding spaces in the SAME
 *     dispatch — multi-caret padding+text is one transaction.
 *   - IME composition never manufactures padding.
 *   - When the policy disables both gates, every virtual position collapses
 *     back to its legal document column.
 */

export interface VisualColumnPosition {
  line: number;
  /** 0-based column within the line's actual text. */
  documentColumn: number;
  /** Rendered column including tab expansion and double-width characters. */
  visualColumn: number;
  /**
   * Visual columns available past this line's end under the active policy
   * (0 when disabled; capped so measurements stay finite).
   */
  virtualColumns: number;
}


/**
 * Measure §8.19.5 VisualColumnPosition facts for every selection head.
 * Pure observation — never mutates state or history.
 */
export function measureVisualPositions(
  state: EditorState,
  tabWidth: number,
): VisualColumnPosition[] {
  const policy = state.facet(editorVirtualSpacePolicy);
  return state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head);
    const documentColumn = range.head - line.from;
    const isLastLine = line.number === state.doc.lines;
    const allowed = isLastLine ? policy.atFileBottom : policy.afterLineEnd;
    const overflow = virtualOverflowAt(state, range.head);
    return {
      line: line.number - 1,
      documentColumn,
      visualColumn: visualColumnFor(line.text, documentColumn, tabWidth),
      virtualColumns: allowed ? Math.min(overflow || MAX_OVERFLOW_COLUMNS, MAX_OVERFLOW_COLUMNS) : 0,
    };
  });
}


/**
 * Check whether CodeMirror line block and viewport geometry are ready.
 * Geometry is ready when viewport height and line height are positive non-zero numbers
 * and line block lookup methods are available.
 */
export function isEditorGeometryReady(view: EditorView): boolean {
  if (!view.dom || !view.scrollDOM) return false;
  const viewportHeight = view.scrollDOM.clientHeight || view.dom.clientHeight;
  const lineHeight = view.defaultLineHeight;
  return viewportHeight > 0 && lineHeight > 0 && typeof view.lineBlockAt === "function" && typeof view.lineBlockAtHeight === "function";
}


export interface TargetVisualBlock {
  from: number;
  to: number;
  /** Exact caret returned by CodeMirror's rendered-geometry navigation. */
  head?: number;
  /** Rendered horizontal goal returned by CodeMirror, in CSS pixels. */
  goalColumn?: number;
}


/**
 * Locate target visual block based on real display geometry, supporting soft wrapping,
 * dynamic line height, and viewport height.
 */
export function resolveTargetVisualBlock(
  view: EditorView,
  head: number,
  direction: "up" | "down" | "pageUp" | "pageDown",
  goalColumn?: number,
): TargetVisualBlock | null {
  const state = view.state;
  const currentLine = state.doc.lineAt(head);

  if (isEditorGeometryReady(view)) {
    try {
      const viewportHeight = view.scrollDOM.clientHeight || view.dom.clientHeight;
      const pageDistance = Math.max(view.defaultLineHeight, viewportHeight - view.defaultLineHeight);
      const start = EditorSelection.cursor(head, 1, undefined, goalColumn);
      const forward = direction === "down" || direction === "pageDown";
      const target = direction === "pageUp" || direction === "pageDown"
        ? view.moveVertically(start, forward, pageDistance)
        : view.moveVertically(start, forward);
      const targetLine = state.doc.lineAt(target.head);
      return {
        from: targetLine.from,
        to: targetLine.to,
        head: target.head,
        goalColumn: target.goalColumn ?? undefined,
      };
    } catch {
      // Fall through to non-geometry fallback
    }
  }

  // When geometry is NOT ready:
  // For Page movement: return null so caller yields to default handler without guessing fixed 15 lines (§ED-VSPACE-002).
  if (direction === "pageUp" || direction === "pageDown") {
    return null;
  }

  // Single line fallback (line arithmetic):
  const delta = direction === "up" ? -1 : 1;
  const targetLineNumber = Math.min(state.doc.lines, Math.max(1, currentLine.number + delta));
  const targetLine = state.doc.line(targetLineNumber);
  return { from: targetLine.from, to: targetLine.to };
}

export { charVisualWidth, visualColumnFor, documentColumnForVisualColumn } from "./columns";
