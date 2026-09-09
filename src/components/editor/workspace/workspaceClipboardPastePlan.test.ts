import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { buildMultiCaretPastePlan } from "./workspaceEditorCommands";

/**
 * ED-AUDIT-010: production multi-caret distribution must match the documented
 * workspaceClipboardSession.planPaste contract (1:1, cycle fewer, drop extra).
 * Baseline buildMultiCaretPastePlan fell back to whole-block on any mismatch.
 */
function stateWithCarets(doc: string, caretCount: number): EditorState {
  const ranges = Array.from({ length: caretCount }, (_, index) =>
    EditorSelection.cursor(Math.min(index, doc.length)),
  );
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
}

describe("ED-AUDIT-010 production paste distribution matches planPaste", () => {
  it("cycles fewer segments across more carets (2 segments -> 3 carets)", () => {
    const state = stateWithCarets("a\nb\nc\nd", 3);
    const plan = buildMultiCaretPastePlan(state, {
      plainText: "X\nY",
      segments: ["X", "Y"],
      sourceEol: "lf",
      rectangular: false,
    });
    expect(plan).not.toBeNull();
    const inserts = (plan!.changes as unknown as Array<{ insert?: string }>).map((c) => c.insert);
    expect(inserts).toEqual(["X", "Y", "X"]);
  });

  it("drops extra segments when more segments than carets (3 segments -> 2 carets)", () => {
    const state = stateWithCarets("a\nb\nc", 2);
    const plan = buildMultiCaretPastePlan(state, {
      plainText: "a\nb\nc",
      segments: ["a", "b", "c"],
      sourceEol: "lf",
      rectangular: false,
    });
    expect(plan).not.toBeNull();
    const inserts = (plan!.changes as unknown as Array<{ insert?: string }>).map((c) => c.insert);
    expect(inserts).toEqual(["a", "b"]);
  });

  it("pastes the whole block to a single caret without dropping segments (2 segments -> 1 caret)", () => {
    const state = stateWithCarets("ab", 1);
    const plan = buildMultiCaretPastePlan(state, {
      plainText: "X\nY",
      segments: ["X", "Y"],
      sourceEol: "lf",
      rectangular: false,
    });
    expect(plan).not.toBeNull();
    const inserts = (plan!.changes as unknown as Array<{ insert?: string }>).map((c) => c.insert);
    // ED-CLIP-004 regression: single-caret fallback must not lose the copy.
    expect(inserts).toEqual(["X\nY"]);
  });
});
