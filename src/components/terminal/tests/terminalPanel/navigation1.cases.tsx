import { describe, expect, it } from "vitest";
import { collectTerminalBlockSelectionText } from "../../TerminalPanel";

export function registerTerminalPanelNavigation1Cases() {

  describe("terminal block selection helpers", () => {
    it("extracts fixed-column text across terminal buffer rows", () => {
      const rows = ["alpha bravo", "xy", "123456789"];
      const term = {
        cols: 12,
        buffer: {
          active: {
            getLine: (row: number) => ({
              translateToString: () => rows[row] ?? "",
            }),
          },
        },
      };

      expect(
        collectTerminalBlockSelectionText(term as never, {
          anchor: { row: 2, col: 5 },
          focus: { row: 0, col: 2 },
        }),
      ).toBe("pha\n\n3456");
    });
  });
}
