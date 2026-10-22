import { Facet } from "@codemirror/state";


/**
 * §8.19.5 policy gates (canonical definition; re-exported by
 * workspaceEditorCommands for its existing consumers).
 */
export interface EditorVirtualSpacePolicy {
  afterLineEnd: boolean;
  atFileBottom: boolean;
}


export const editorVirtualSpacePolicy = Facet.define<
  EditorVirtualSpacePolicy,
  EditorVirtualSpacePolicy
>({
  combine(values) {
    return values[values.length - 1] ?? {
      afterLineEnd: false,
      atFileBottom: false,
    };
  },
});


/**
 * §8.21.3 V2-C Honest declaration of known gaps in virtual space and region folding:
 * - Soft-wrap conflict: Soft line wrapping breaks single physical lines into multiple visual lines.
 *   Virtual space overflow beyond physical line end is supported at the end of the physical paragraph,
 *   but intermediate wrapped lines wrap to the viewport margin and cannot host virtual space.
 * - Multi-column rectangular selection: Multi-caret block selection pads spaces upon character entry,
 *   but 2D block rendering beyond right margin does not draw continuous empty box glyphs.
 * - Indentation fold fallback: Uses strict indentation level heuristics when language grammar AST
 *   is unavailable, but does not identify block delimiters (e.g. end keywords or braces) without a parser.
 */
export const VIRTUAL_SPACE_KNOWN_GAPS = [
  {
    feature: "soft-wrap",
    behavior: "Virtual space after line end only applies to the final physical line end; intermediate visual wrap lines terminate at viewport boundary.",
  },
  {
    feature: "rectangular-selection",
    behavior: "Rectangular columns in virtual space pad spaces upon typing; full 2D block background box rendering is limited to document bounds.",
  },
  {
    feature: "indent-folding-fallback",
    behavior: "Pure indent fallback operates on indentation levels without grammar token analysis.",
  },
] as const;
