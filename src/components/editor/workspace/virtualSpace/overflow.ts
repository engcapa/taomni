import type { EditorState } from "@codemirror/state";
import { StateEffect, StateField } from "@codemirror/state";
import { visualColumnFor } from "./columns";
import { editorVirtualSpacePolicy } from "./policy";

/** Per-head overflow map keyed by the CLAMPED head offset. */
export type VirtualOverflowMap = ReadonlyMap<number, number>;

export const setVirtualOverflow = StateEffect.define<VirtualOverflowMap>();

export const MAX_OVERFLOW_COLUMNS = 200;

/**
 * ED-AUDIT-002: overflow consumed by a real insertion is recorded here so the
 * undo transaction that reverts that insertion can restore the virtual caret
 * (IDEA keeps the caret past EOL after undoing a virtual-space insert). The
 * record survives plain typing/selection traffic and is invalidated by an
 * explicit overflow manipulation (Escape, Home, navigation) or a newer
 * consumption. Must be declared before `virtualSpaceOverflowField`.
 */
export const setVirtualOverflowRestore = StateEffect.define<VirtualOverflowMap>();

export const virtualOverflowRestoreField = StateField.define<VirtualOverflowMap>({
  create: () => new Map<number, number>(),
  update(value, tr) {
    const restore = tr.effects.find((candidate) => candidate.is(setVirtualOverflowRestore));
    if (restore) return restore.value;
    // An overflow write that is not a consumption (Escape, Home, movement)
    // invalidates the pending restore record.
    if (tr.effects.some((candidate) => candidate.is(setVirtualOverflow))) return new Map();
    return value;
  },
});

export const virtualSpaceOverflowField = StateField.define<VirtualOverflowMap>({
  create: () => new Map<number, number>(),
  update(value, tr) {
    const policy = tr.state.facet(editorVirtualSpacePolicy);
    if (!policy.afterLineEnd && !policy.atFileBottom) return new Map();
    const effect = tr.effects.find((candidate) => candidate.is(setVirtualOverflow));
    if (effect) {
      // Drop entries whose clamped head no longer matches a selection head.
      const heads = new Set(tr.state.selection.ranges.map((range) => range.head));
      const pruned = new Map<number, number>();
      for (const [head, overflow] of effect.value) {
        if (heads.has(head) && overflow > 0) pruned.set(head, overflow);
      }
      return pruned;
    }
    if (!tr.docChanged) {
      // Selection-only moves keep overflow for heads that did not move away
      // from their line end; any document edit collapses everything.
      if (value.size === 0) return value;
      const retained = new Map<number, number>();
      for (const range of tr.state.selection.ranges) {
        const overflow = value.get(range.head);
        if (overflow != null) retained.set(range.head, overflow);
      }
      return retained.size === value.size ? value : retained;
    }
    if (tr.isUserEvent("undo")) {
      // ED-AUDIT-002: an undo landing a caret back on a recorded pre-insert
      // head restores that virtual caret; other heads stay real.
      const restore = tr.startState.field(virtualOverflowRestoreField, false);
      if (restore && restore.size > 0) {
        const restored = new Map<number, number>();
        for (const range of tr.state.selection.ranges) {
          const overflow = restore.get(range.head);
          if (overflow != null && overflow > 0) restored.set(range.head, overflow);
        }
        if (restored.size > 0) return restored;
      }
    }
    return new Map();
  },
});

/** Read the overflow for one head offset (0 when none). */
export function virtualOverflowAt(state: EditorState, head: number): number {
  return state.field(virtualSpaceOverflowField, false)?.get(head) ?? 0;
}

/** Per-caret desired visual column tracked across vertical navigation. */
export const setDesiredVisualColumns = StateEffect.define<readonly number[]>();

export const desiredVisualColumnField = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    const effect = tr.effects.find((candidate) => candidate.is(setDesiredVisualColumns));
    if (effect) return effect.value;
    if (tr.selection) {
      const tabWidth = tr.state.tabSize;
      return tr.state.selection.ranges.map((range) => {
        const line = tr.state.doc.lineAt(range.head);
        const docCol = range.head - line.from;
        const overflow = virtualOverflowAt(tr.state, range.head);
        return visualColumnFor(line.text, docCol, tabWidth) + overflow;
      });
    }
    return value;
  },
});
