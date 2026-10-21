import { describe, expect, it } from "vitest";
import { searchMatchesToReplaceInputs, verifyReplaceMatchFreshness, type ReplaceInFilesMatch } from "../../replaceInFilesModel";

export function registerreplaceInFilesModelBehavior2Cases() {

  describe("ED-REPAIR-003: strict freshness and disappeared/illegal coordinate rejection", () => {
    function matchForLine(lineText: string, lineNumber: number, matchStart: number, matchEnd: number) {
      return {
        rootId: "app",
        rootName: "app",
        rootPath: "/ws",
        path: "src/a.ts",
        lineNumber,
        column: 1,
        matchStart,
        matchEnd,
        lineText,
      };
    }

    it("blocks replace when the target line disappeared on disk (foo\\nfoo -> foo) (ED-REPAIR-003-A1)", () => {
      // Search found "foo" on second line (lineNumber: 2 -> startLine: 1)
      const [secondLineMatch] = searchMatchesToReplaceInputs([matchForLine("foo", 2, 0, 3)]);
      expect(secondLineMatch.startLine).toBe(1);
      expect(secondLineMatch.matchedText).toBe("foo");

      // Disk changed from "foo\nfoo" to "foo" before commit (second line disappeared)
      const diskText = "foo";
      const disk = new Map([["/ws/src/a.ts", diskText]]);

      // Freshness check must NOT clamp line 1 to line 0; must return conflict
      const conflicts = verifyReplaceMatchFreshness(disk, [secondLineMatch]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.path).toBe("/ws/src/a.ts");
      expect(conflicts[0]!.reason).toContain("changed since search (line 2)");

      // If an edit were attempted with clamp, it would corrupt line 0.
      // Confirm that the conflict prevents building or applying changes to the surviving line.
    });

    it("blocks replace when the target line was shortened on disk (ED-REPAIR-003-A1)", () => {
      // Search found "bar" at [3, 6) on line 1
      const [input] = searchMatchesToReplaceInputs([matchForLine("foobar", 1, 3, 6)]);
      expect(input.startCharacter).toBe(3);
      expect(input.endCharacter).toBe(6);

      // Disk shortened the line to "foo" (length 3)
      const disk = new Map([["/ws/src/a.ts", "foo"]]);
      const conflicts = verifyReplaceMatchFreshness(disk, [input]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.reason).toContain("changed since search (line 1)");
    });

    it("rejects non-integer, zero, negative, and NaN lineNumber in searchMatchesToReplaceInputs (ED-REPAIR-003-A1)", () => {
      const invalidLineNumbers = [0, -1, -5, 1.5, 2.7, Number.NaN, Number.POSITIVE_INFINITY];
      for (const badLine of invalidLineNumbers) {
        expect(() => searchMatchesToReplaceInputs([
          matchForLine("foo", badLine, 0, 3),
        ])).toThrow(/invalid line number/i);
      }
    });

    it("rejects illegal coordinates in verifyReplaceMatchFreshness without clamping (ED-REPAIR-003-A1)", () => {
      const validMatch: ReplaceInFilesMatch = {
        filePath: "/ws/src/a.ts",
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 3,
        matchedText: "foo",
      };
      const disk = new Map([["/ws/src/a.ts", "foo\nbar"]]);

      // Negative line
      expect(verifyReplaceMatchFreshness(disk, [{ ...validMatch, startLine: -1, endLine: -1 }])).toHaveLength(1);
      // Non-integer line
      expect(verifyReplaceMatchFreshness(disk, [{ ...validMatch, startLine: 0.5, endLine: 0.5 }])).toHaveLength(1);
      // NaN line
      expect(verifyReplaceMatchFreshness(disk, [{ ...validMatch, startLine: Number.NaN, endLine: Number.NaN }])).toHaveLength(1);
      // Multi-line range
      expect(verifyReplaceMatchFreshness(disk, [{ ...validMatch, startLine: 0, endLine: 1 }])).toHaveLength(1);
      // Reversed character range
      expect(verifyReplaceMatchFreshness(disk, [{ ...validMatch, startCharacter: 3, endCharacter: 0 }])).toHaveLength(1);
      // Non-integer character
      expect(verifyReplaceMatchFreshness(disk, [{ ...validMatch, startCharacter: 0.5 }])).toHaveLength(1);
    });

    it("validates freshness across LF, CRLF, isolated CR, and mixed EOL (ED-REPAIR-003-A2)", () => {
      const [matchLine2] = searchMatchesToReplaceInputs([matchForLine("target", 2, 0, 6)]);

      // LF
      expect(verifyReplaceMatchFreshness(
        new Map([["/ws/src/a.ts", "first\ntarget\nthird"]]),
        [matchLine2],
      )).toEqual([]);

      // CRLF
      expect(verifyReplaceMatchFreshness(
        new Map([["/ws/src/a.ts", "first\r\ntarget\r\nthird"]]),
        [matchLine2],
      )).toEqual([]);

      // Isolated CR
      expect(verifyReplaceMatchFreshness(
        new Map([["/ws/src/a.ts", "first\rtarget\rthird"]]),
        [matchLine2],
      )).toEqual([]);

      // Mixed EOL
      expect(verifyReplaceMatchFreshness(
        new Map([["/ws/src/a.ts", "first\r\ntarget\rthird\nfourth"]]),
        [matchLine2],
      )).toEqual([]);
    });

    it("preserves exact UTF-16 coordinates for astral symbols and emojis (ED-REPAIR-003-A2)", () => {
      const line = "🌟hello 🚀world";
      // 🌟 is 1 code point, 2 UTF-16 code units.
      // "hello" starts at code point 1 (UTF-16 offset 2) and ends at code point 6 (UTF-16 offset 7).
      const [helloMatch] = searchMatchesToReplaceInputs([matchForLine(line, 1, 1, 6)]);
      expect(helloMatch.startCharacter).toBe(2);
      expect(helloMatch.endCharacter).toBe(7);
      expect(helloMatch.matchedText).toBe("hello");

      const disk = new Map([["/ws/src/a.ts", `${line}\n`]]);
      expect(verifyReplaceMatchFreshness(disk, [helloMatch])).toEqual([]);

      // Modifying the emoji prefix shifts the offset and is detected as conflict
      const modifiedDisk = new Map([["/ws/src/a.ts", `hello 🚀world\n`]]);
      expect(verifyReplaceMatchFreshness(modifiedDisk, [helloMatch])).toHaveLength(1);
    });
  });
}
