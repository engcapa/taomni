import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { charVisualWidth, measureVisualPositions, virtualSpaceOverflowField } from "../../workspaceVirtualSpace";
import { POLICY, visualColumnOf } from "./harness";

export function registerworkspaceVirtualSpaceBehavior1Cases() {

  describe("§8.19.5 visual column model", () => {
    it("expands tabs to stops and double-width characters", () => {
      expect(charVisualWidth("a", 0, 4)).toBe(1);
      expect(charVisualWidth("\t", 0, 4)).toBe(4);
      expect(charVisualWidth("\t", 3, 4)).toBe(1);
      expect(charVisualWidth("你", 0, 4)).toBe(2);
      expect(charVisualWidth("😀", 0, 4)).toBe(2);
      // Tab stop alignment inside mixed content: a,b at cols 0,1 then tab→4, c→5.
      expect(visualColumnOf("ab\tc", 4, 4)).toBe(5);
    });

    it("measures VisualColumnPosition per caret with policy gates", () => {
      const doc = "ab\nlonger line";
      const state = EditorState.create({
        doc,
        selection: EditorSelection.cursor(doc.length),
        extensions: [virtualSpaceOverflowField, POLICY],
      });
      const positions = measureVisualPositions(state, 4);
      expect(positions).toHaveLength(1);
      expect(positions[0].line).toBe(1);
      expect(positions[0].documentColumn).toBe(11); // end of "longer line"
      // atFileBottom on the last line allows virtual columns.
      expect(positions[0].virtualColumns).toBeGreaterThan(0);

      const off = EditorState.create({
        doc,
        selection: EditorSelection.cursor(doc.length),
        extensions: [virtualSpaceOverflowField],
      });
      expect(measureVisualPositions(off, 4)[0].virtualColumns).toBe(0);
    });
  });
}
