import { describe, expect, it } from "vitest";
import {
  buildReplaceInFilesWorkspaceEdit,
  codePointOffsetToUtf16Offset,
  collectReplacePreimages,
  createReplaceInFilesPlan,
  findReplacePreimage,
  replaceEditSignature,
  replaceMatchStableKey,
  replacePreimageExpectedHashes,
  replacePreimagePathKey,
  replaceScopeIdentityFromPlan,
  searchMatchesToReplaceInputs,
  summarizeReplaceCommitReport,
  validateReplacePreconditions,
  validateReplacePreflight,
  validateReplacePreviewSelection,
  verifyReplaceMatchFreshness,
  type ReplaceInFilesMatch,
  type ReplacePreflightFileInput,
  type ReplacePrepareRequestIdentity,
  type ReplacePreviewSnapshot,
  type ReplaceScopeIdentity,
} from "./replaceInFilesModel";
import { planFindInFilesScope } from "./findInFilesScopeModel";
import { applyLspTextEditsToString } from "./lspTextEdits";

describe("ED-FIND-004: replaceInFilesModel preview, exclude, conflict guard, commit", () => {
  const sampleMatches: ReplaceInFilesMatch[] = [
    {
      filePath: "/ws/core/Service.java",
      startLine: 10,
      startCharacter: 4,
      endLine: 10,
      endCharacter: 11,
      matchedText: "oldName",
    },
    {
      filePath: "/ws/core/Service.java",
      startLine: 25,
      startCharacter: 8,
      endLine: 25,
      endCharacter: 15,
      matchedText: "oldName",
    },
    {
      filePath: "/ws/app/App.java",
      startLine: 5,
      startCharacter: 12,
      endLine: 5,
      endCharacter: 19,
      matchedText: "oldName",
    },
  ];

  it("builds multi-file WorkspaceEdit from match list", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({
      matches: sampleMatches,
      replacementText: "newName",
    });

    expect(edit.documentEdits).toHaveLength(2);
    expect(edit.documentEdits[0].edits).toHaveLength(2);
    expect(edit.documentEdits[1].edits).toHaveLength(1);
    expect(edit.documentEdits[0].edits[0].newText).toBe("newName");
  });

  it("creates structured preview and supports per-occurrence exclusion", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({
      matches: sampleMatches,
      replacementText: "newName",
    });

    const initialPlan = createReplaceInFilesPlan(edit);
    expect(initialPlan.totalMatches).toBe(3);
    expect(initialPlan.includedMatches).toBe(3);
    expect(initialPlan.preview.entries).toHaveLength(2);

    // Exclude first usage of first file (0:0)
    const excludedPlan = createReplaceInFilesPlan(edit, new Set(["0:0"]));
    expect(excludedPlan.totalMatches).toBe(3);
    expect(excludedPlan.includedMatches).toBe(2);
    expect(excludedPlan.filteredEdit.documentEdits[0].edits).toHaveLength(1);
    expect(excludedPlan.filteredEdit.documentEdits[0].edits[0].range.start.line).toBe(25);
  });

  it("validates file revision and dirty buffer preconditions", () => {
    // Clean files with matching hashes
    const cleanCheck = validateReplacePreconditions([
      { path: "/ws/core/Service.java", expectedHash: "aaa111", actualHash: "aaa111", isDirty: false },
      { path: "/ws/app/App.java", expectedHash: "bbb222", actualHash: "bbb222", isDirty: false },
    ]);
    expect(cleanCheck.canCommit).toBe(true);
    expect(cleanCheck.conflicts).toHaveLength(0);

    // Dirty open buffer conflict
    const dirtyCheck = validateReplacePreconditions([
      { path: "/ws/core/Service.java", isDirty: true },
    ]);
    expect(dirtyCheck.canCommit).toBe(false);
    expect(dirtyCheck.conflicts[0].reason).toContain("unsaved modifications");

    // External disk modification hash mismatch
    const hashCheck = validateReplacePreconditions([
      { path: "/ws/core/Service.java", expectedHash: "aaa111", actualHash: "ccc333", isDirty: false },
    ]);
    expect(hashCheck.canCommit).toBe(false);
    expect(hashCheck.conflicts[0].reason).toContain("hash mismatch");
  });
});

describe("ED-FIND-004: replace match freshness against disk", () => {
  const disk = new Map<string, string>([
    ["/ws/a.ts", "const alpha = 1;\nconst beta = 2;\n"],
    ["/ws/b.ts", "nothing here\n"],
  ]);

  it("passes when every match still sits on current disk text", () => {
    const conflicts = verifyReplaceMatchFreshness(disk, [
      { filePath: "/ws/a.ts", startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 11, matchedText: "alpha" },
    ]);
    expect(conflicts).toEqual([]);
  });

  it("reports moved text, missing files, and unknown files", () => {
    const conflicts = verifyReplaceMatchFreshness(disk, [
      { filePath: "/ws/a.ts", startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 11, matchedText: "ALPHA" },
      { filePath: "/ws/gone.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3, matchedText: "x" },
    ]);
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].path).toBe("/ws/a.ts");
    expect(conflicts[0].reason).toContain("changed since search");
    expect(conflicts[1].path).toBe("/ws/gone.ts");
  });
});

describe("ED-AUDIT-003: replace commit report from the applier ledger", () => {
  const matches: ReplaceInFilesMatch[] = [
    { filePath: "/ws/a.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, matchedText: "needle" },
    { filePath: "/ws/a.ts", startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 6, matchedText: "needle" },
    { filePath: "/ws/b.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, matchedText: "needle" },
  ];

  it("reports full success only when every document applied", () => {
    const report = summarizeReplaceCommitReport([
      { path: "/ws/a.ts", status: "applied-disk" },
      { path: "/ws/b.ts", status: "applied-open", reason: undefined },
    ], matches);
    expect(report.ok).toBe(true);
    expect(report.appliedCount).toBe(3);
    expect(report.fileCount).toBe(2);
    expect(report.blockers).toEqual([]);
    expect(report.message).toContain("Replaced 3 occurrences in 2 files");
  });

  it("reports the real applied set when one document fails (readonly/disk)", () => {
    const report = summarizeReplaceCommitReport([
      { path: "/ws/a.ts", status: "applied-disk" },
      { path: "/ws/b.ts", status: "failed", reason: "Permission denied (os error 13)" },
    ], matches);
    expect(report.ok).toBe(false);
    expect(report.appliedCount).toBe(2);
    expect(report.fileCount).toBe(1);
    expect(report.blockers).toEqual(["/ws/b.ts: Permission denied (os error 13)"]);
    expect(report.message).toContain("partially applied: 2 of 3 occurrences in 1 of 2 files");
    expect(report.message).toContain("/ws/b.ts: Permission denied");
  });

  it("reports zero effect when the first document fails before any write", () => {
    const report = summarizeReplaceCommitReport([
      { path: "/ws/a.ts", status: "failed", reason: "write cancelled before write: denied" },
    ], matches);
    expect(report.ok).toBe(false);
    expect(report.appliedCount).toBe(0);
    expect(report.fileCount).toBe(0);
    expect(report.message).toContain("nothing applied");
  });

  it("treats a skipped preview-decline as a blocker, not success", () => {
    const report = summarizeReplaceCommitReport([
      { path: "WorkspaceEdit", status: "skipped", reason: "WorkspaceEdit preview was declined" },
    ], matches);
    expect(report.ok).toBe(false);
    expect(report.appliedCount).toBe(0);
    expect(report.blockers[0]).toContain("preview was declined");
  });

  it("compares Windows paths case-insensitively across outcome and match", () => {
    const windowsMatches: ReplaceInFilesMatch[] = [
      { filePath: "C:/Repo/App/src/a.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, matchedText: "needle" },
    ];
    const report = summarizeReplaceCommitReport([
      { path: "c:/repo/app/src/a.ts", status: "applied-disk" },
    ], windowsMatches);
    expect(report.ok).toBe(true);
    expect(report.appliedCount).toBe(1);
    expect(report.fileCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ED-IMPROVE-004: the backend reports Unicode code-point offsets, while LSP
// ranges and the editor use UTF-16 code units. Every consumer must share one
// mapping so preview, navigation, freshness and commit agree.
// ---------------------------------------------------------------------------
describe("ED-IMPROVE-004: code-point offsets map to UTF-16 LSP ranges", () => {
  const LINE = "const s = \"\u{1F600}foo\";";
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  function searchMatch(overrides: {
    lineText?: string;
    matchStart?: number;
    matchEnd?: number;
  } = {}) {
    return {
      rootId: "app",
      rootName: "app",
      rootPath: "/ws",
      path: "src/a.ts",
      lineNumber: 1,
      column: 1,
      matchStart: 12,
      matchEnd: 15,
      lineText: LINE,
      ...overrides,
    };
  }

  it("converts code-point indices to UTF-16 indices", () => {
    expect(codePointOffsetToUtf16Offset(LINE, 0)).toBe(0);
    expect(codePointOffsetToUtf16Offset(LINE, 11)).toBe(11);
    expect(codePointOffsetToUtf16Offset(LINE, 12)).toBe(13);
    expect(codePointOffsetToUtf16Offset(LINE, 13)).toBe(14);
    expect(codePointOffsetToUtf16Offset(LINE, 15)).toBe(16);
    expect(codePointOffsetToUtf16Offset(LINE, 99)).toBe(LINE.length);
    expect(codePointOffsetToUtf16Offset(LINE, -3)).toBe(0);
  });

  it("maps a match after an astral prefix and rewrites it without broken surrogates", () => {
    const [input] = searchMatchesToReplaceInputs([searchMatch()]);
    expect(input.matchedText).toBe("foo");
    expect(input.startCharacter).toBe(13);
    expect(input.endCharacter).toBe(16);

    const edit = buildReplaceInFilesWorkspaceEdit({
      matches: [input],
      replacementText: "bar",
    });
    const next = applyLspTextEditsToString(LINE, edit.documentEdits[0].edits);
    expect(next).toBe("const s = \"\u{1F600}bar\";");
    expect(LONE_SURROGATE.test(next)).toBe(false);
  });

  it("handles multiple astral prefixes and an astral target", () => {
    const line = "\u{1F600}\u{1F680}foo\u{1F600}";
    const [fooMatch] = searchMatchesToReplaceInputs([
      searchMatch({ lineText: line, matchStart: 2, matchEnd: 5 }),
    ]);
    expect(fooMatch.startCharacter).toBe(4);
    expect(fooMatch.endCharacter).toBe(7);
    const fooEdit = buildReplaceInFilesWorkspaceEdit({ matches: [fooMatch], replacementText: "bar" });
    const afterFoo = applyLspTextEditsToString(line, fooEdit.documentEdits[0].edits);
    expect(afterFoo).toBe("\u{1F600}\u{1F680}bar\u{1F600}");
    expect(LONE_SURROGATE.test(afterFoo)).toBe(false);

    const [emojiMatch] = searchMatchesToReplaceInputs([
      searchMatch({ lineText: line, matchStart: 0, matchEnd: 1 }),
    ]);
    expect(emojiMatch.startCharacter).toBe(0);
    expect(emojiMatch.endCharacter).toBe(2);
    expect(emojiMatch.matchedText).toBe("\u{1F600}");
    const emojiEdit = buildReplaceInFilesWorkspaceEdit({ matches: [emojiMatch], replacementText: "x" });
    const afterEmoji = applyLspTextEditsToString(line, emojiEdit.documentEdits[0].edits);
    expect(afterEmoji).toBe("x\u{1F680}foo\u{1F600}");
    expect(LONE_SURROGATE.test(afterEmoji)).toBe(false);
  });

  it("keeps freshness slicing in the same UTF-16 coordinates", () => {
    const [input] = searchMatchesToReplaceInputs([searchMatch()]);
    const disk = new Map([["/ws/src/a.ts", `${LINE}\n`]]);
    expect(verifyReplaceMatchFreshness(disk, [input])).toEqual([]);

    const shifted = `const s = "X\u{1F600}foo";\n`;
    const shiftedConflicts = verifyReplaceMatchFreshness(
      new Map([["/ws/src/a.ts", shifted]]),
      [input],
    );
    expect(shiftedConflicts).toHaveLength(1);
    expect(shiftedConflicts[0].reason).toContain("changed since search");
  });

  it("rejects illegal offsets instead of truncating to a wrong position", () => {
    const [input] = searchMatchesToReplaceInputs([searchMatch()]);
    const disk = new Map([["/ws/src/a.ts", `${LINE}\n`]]);
    const outOfRange = verifyReplaceMatchFreshness(disk, [
      { ...input, startCharacter: 999, endCharacter: 1002 },
    ]);
    expect(outOfRange).toHaveLength(1);
    const reversed = verifyReplaceMatchFreshness(disk, [
      { ...input, startCharacter: 16, endCharacter: 13 },
    ]);
    expect(reversed).toHaveLength(1);
    const negative = verifyReplaceMatchFreshness(disk, [
      { ...input, startCharacter: -1, endCharacter: 3 },
    ]);
    expect(negative).toHaveLength(1);
  });
});

describe("ED-MAIN-004: mixed EOL and illegal search coordinates", () => {
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

  it("accepts a match on a CR-only second line and keeps LF/CRLF/CR consistent", () => {
    const [input] = searchMatchesToReplaceInputs([matchForLine("foo", 2, 0, 3)]);
    expect(input.startLine).toBe(1);
    expect(input.matchedText).toBe("foo");
    expect(verifyReplaceMatchFreshness(
      new Map([["/ws/src/a.ts", "abc\rfoo"]]),
      [input],
    )).toEqual([]);
    expect(verifyReplaceMatchFreshness(
      new Map([["/ws/src/a.ts", "abc\nfoo"]]),
      [input],
    )).toEqual([]);
    expect(verifyReplaceMatchFreshness(
      new Map([["/ws/src/a.ts", "abc\r\nfoo"]]),
      [input],
    )).toEqual([]);
  });

  it("builds and applies an edit on a CR-only line without byte drift", () => {
    const [input] = searchMatchesToReplaceInputs([matchForLine("foo", 2, 0, 3)]);
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: [input], replacementText: "bar" });
    expect(applyLspTextEditsToString("abc\rfoo", edit.documentEdits[0].edits)).toBe("abc\rbar");
  });

  it("throws a typed reason for negative/fraction/NaN/out-of-range/reversed raw offsets", () => {
    const bads = [
      { matchStart: -1, matchEnd: 2 },
      { matchStart: 1.5, matchEnd: 2 },
      { matchStart: Number.NaN, matchEnd: 2 },
      { matchStart: 0, matchEnd: 99 },
      { matchStart: 3, matchEnd: 1 },
    ];
    for (const bad of bads) {
      expect(() => searchMatchesToReplaceInputs([
        matchForLine("foo", 1, bad.matchStart, bad.matchEnd),
      ])).toThrow(/invalid offset .* replace refused/i);
    }
    // The thrown error is a distinct typed class the panel/commit owners catch.
    try {
      searchMatchesToReplaceInputs([matchForLine("foo", 1, -1, 2)]);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).name).toBe("InvalidSearchMatchCoordinatesError");
    }
  });

  it("keeps a valid astral-prefixed match exact and rejects offsets past the line", () => {
    const line = "\u{1F600}foo";
    const [ok] = searchMatchesToReplaceInputs([matchForLine(line, 1, 1, 4)]);
    expect(ok.matchedText).toBe("foo");
    expect(ok.startCharacter).toBe(2);
    expect(ok.endCharacter).toBe(5);
    expect(() => searchMatchesToReplaceInputs([matchForLine(line, 1, 0, 5)]))
      .toThrow(/invalid offset .* replace refused/i);
  });
});

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

// ---------------------------------------------------------------------------
// ED-IMPROVE-005: the frozen preview snapshot is the commit's single source
// of truth for scope, query, replacement, selected matches and edit identity.
// ---------------------------------------------------------------------------
describe("ED-IMPROVE-005: frozen replace preview snapshot", () => {
  const sampleMatches: ReplaceInFilesMatch[] = [
    { filePath: "/ws/A.java", startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 5, matchedText: "foo" },
    { filePath: "/ws/B.java", startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 3, matchedText: "foo" },
    { filePath: "/ws/test/A.test.java", startLine: 0, startCharacter: 4, endLine: 0, endCharacter: 7, matchedText: "foo" },
  ];

  function snapshotFor(edit: ReturnType<typeof buildReplaceInFilesWorkspaceEdit>): ReplacePreviewSnapshot {
    return {
      scope: {
        kind: "project",
        roots: ["/ws"],
        explicitFiles: [],
        fileMask: "*.java",
        generation: 3,
      },
      query: {
        query: "foo",
        caseSensitive: false,
        wholeWord: false,
        regexp: false,
        includeGlobs: ["**/*.java"],
        excludeGlobs: ["*.test.java"],
      },
      replacement: "bar",
      matchKeys: sampleMatches.map(replaceMatchStableKey),
      matchCount: sampleMatches.length,
      editSignature: replaceEditSignature(edit),
      capturedAt: 1,
    };
  }

  it("derives the scope identity from a live scope plan", () => {
    const plan = planFindInFilesScope(
      { kind: "project", workspaceRoot: "/ws", fileMask: "*.java" },
      { generation: 7 } as never,
    );
    expect(replaceScopeIdentityFromPlan(plan)).toEqual({
      kind: "project",
      roots: ["/ws"],
      explicitFiles: [],
      fileMask: "*.java",
      generation: 7,
    });
  });

  it("builds a deterministic edit signature that changes with the text or ranges", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches, replacementText: "bar" });
    const same = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches, replacementText: "bar" });
    const otherText = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches, replacementText: "baz" });
    const otherRange = buildReplaceInFilesWorkspaceEdit({
      matches: sampleMatches.map((match, index) => index === 0 ? { ...match, startCharacter: 1 } : match),
      replacementText: "bar",
    });
    expect(replaceEditSignature(edit)).toBe(replaceEditSignature(same));
    expect(replaceEditSignature(edit)).not.toBe(replaceEditSignature(otherText));
    expect(replaceEditSignature(edit)).not.toBe(replaceEditSignature(otherRange));
  });

  it("accepts a selected subset that stays inside the frozen snapshot", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches, replacementText: "bar" });
    const snapshot = snapshotFor(edit);
    const filtered = createReplaceInFilesPlan(edit, new Set(["0:0"])).filteredEdit;
    const subsetKeys = new Set(sampleMatches.slice(1).map(replaceMatchStableKey));
    expect(validateReplacePreviewSelection(snapshot, subsetKeys, filtered)).toEqual({ ok: true });
  });

  it("rejects selections outside the snapshot, count drift and replacement drift", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches, replacementText: "bar" });
    const snapshot = snapshotFor(edit);
    const allKeys = new Set(sampleMatches.map(replaceMatchStableKey));

    const outside = validateReplacePreviewSelection(
      snapshot,
      new Set([...allKeys, "/ws/new.java:0:0:0:3"]),
      edit,
    );
    expect(outside.ok).toBe(false);
    expect(outside.reason).toContain("not part of the frozen replace preview");

    const wrongCount = validateReplacePreviewSelection(snapshot, new Set(), edit);
    expect(wrongCount.ok).toBe(false);
    expect(wrongCount.reason).toContain("reopen the preview");

    const driftedEdit = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches, replacementText: "baz" });
    const driftedText = validateReplacePreviewSelection(snapshot, allKeys, driftedEdit);
    expect(driftedText.ok).toBe(false);
    expect(driftedText.reason).toContain("frozen replacement");
  });

  it("rejects a same-count selection whose path/range was swapped (ED-MAIN-005)", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches, replacementText: "bar" });
    const snapshot = snapshotFor(edit);
    const allKeys = new Set(sampleMatches.map(replaceMatchStableKey));
    // Same number of edits and the frozen replacement, but one range moved.
    const swapped = buildReplaceInFilesWorkspaceEdit({
      matches: sampleMatches.map((match, index) => (
        index === 0 ? { ...match, startCharacter: match.startCharacter + 1 } : match
      )),
      replacementText: "bar",
    });
    const result = validateReplacePreviewSelection(snapshot, allKeys, swapped, edit);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not part of the original replace plan");
    // The genuine frozen edit still passes the per-item source check.
    expect(validateReplacePreviewSelection(snapshot, allKeys, edit, edit)).toEqual({ ok: true });
  });

  it("derives per-file expected hashes from the frozen preimages (ED-MAIN-005)", () => {
    expect(replacePreimageExpectedHashes({})).toEqual(new Map());
    const preimages = [
      {
        path: "/ws/A.java",
        uri: "file:///ws/A.java",
        textHash: "hash-a",
        encoding: "UTF-8",
        bom: false,
        eol: "lf" as const,
        bufferRevision: 3,
        dirty: false,
        readOnly: false,
        workspaceInstanceId: "ws",
      },
      {
        path: "C:\\Ws\\B.java",
        uri: "file:///C:/Ws/B.java",
        textHash: "hash-b",
        encoding: "UTF-8",
        bom: false,
        eol: "crlf" as const,
        bufferRevision: null,
        dirty: true,
        readOnly: true,
        workspaceInstanceId: "ws",
      },
    ];
    const hashes = replacePreimageExpectedHashes({ preimages });
    expect(hashes.get(replacePreimagePathKey("/ws/A.java"))).toBe("hash-a");
    expect(hashes.get(replacePreimagePathKey("C:\\Ws\\B.java"))).toBe("hash-b");
    expect(findReplacePreimage({ preimages }, "/ws/A.java")?.textHash).toBe("hash-a");
    expect(findReplacePreimage({ preimages }, "/ws/missing.java")).toBeNull();
  });

  describe("ED-REPAIR-006: case-preserving POSIX and canonical Windows replace path identity", () => {
    it("preserves distinct identities for /ws/A.java and /ws/a.java in preimages and hashes (ED-REPAIR-006-A1)", () => {
      const preimages = [
        {
          path: "/ws/A.java",
          uri: "file:///ws/A.java",
          textHash: "hash-upper-A",
          encoding: "UTF-8",
          bom: false,
          eol: "lf" as const,
          bufferRevision: 1,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws",
        },
        {
          path: "/ws/a.java",
          uri: "file:///ws/a.java",
          textHash: "hash-lower-a",
          encoding: "UTF-8",
          bom: false,
          eol: "lf" as const,
          bufferRevision: 2,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws",
        },
      ];

      // Key must preserve case on POSIX
      expect(replacePreimagePathKey("/ws/A.java")).toBe("/ws/A.java");
      expect(replacePreimagePathKey("/ws/a.java")).toBe("/ws/a.java");
      expect(replacePreimagePathKey("/ws/A.java")).not.toBe(replacePreimagePathKey("/ws/a.java"));

      // Hashes map must contain both preimages without overwriting
      const hashes = replacePreimageExpectedHashes({ preimages });
      expect(hashes.size).toBe(2);
      expect(hashes.get(replacePreimagePathKey("/ws/A.java"))).toBe("hash-upper-A");
      expect(hashes.get(replacePreimagePathKey("/ws/a.java"))).toBe("hash-lower-a");

      // findReplacePreimage finds each file individually
      expect(findReplacePreimage({ preimages }, "/ws/A.java")?.textHash).toBe("hash-upper-A");
      expect(findReplacePreimage({ preimages }, "/ws/a.java")?.textHash).toBe("hash-lower-a");
      expect(findReplacePreimage({ preimages }, "file:///ws/A.java")?.textHash).toBe("hash-upper-A");
      expect(findReplacePreimage({ preimages }, "file:///ws/a.java")?.textHash).toBe("hash-lower-a");
    });

    it("generates separate document edits and validates selective subsets for case-distinct POSIX files (ED-REPAIR-006-A1)", () => {
      const matchUpperA: ReplaceInFilesMatch = {
        filePath: "/ws/A.java",
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 3,
        matchedText: "foo",
      };
      const matchLowerA: ReplaceInFilesMatch = {
        filePath: "/ws/a.java",
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 3,
        matchedText: "foo",
      };

      const edit = buildReplaceInFilesWorkspaceEdit({
        matches: [matchUpperA, matchLowerA],
        replacementText: "bar",
      });

      // Must generate two distinct file document edits, NOT merge them
      expect(edit.documentEdits).toHaveLength(2);
      expect(edit.documentEdits.map((d) => d.path)).toEqual(["/ws/A.java", "/ws/a.java"]);

      const snapshot: ReplacePreviewSnapshot = {
        scope: {
          kind: "workspace",
          roots: ["/ws"],
          explicitFiles: [],
          fileMask: null,
          generation: 1,
        },
        query: {
          query: "foo",
          caseSensitive: true,
          wholeWord: false,
          regexp: false,
          includeGlobs: [],
          excludeGlobs: [],
        },
        replacement: "bar",
        matchKeys: [replaceMatchStableKey(matchUpperA), replaceMatchStableKey(matchLowerA)],
        matchCount: 2,
        editSignature: replaceEditSignature(edit),
        capturedAt: Date.now(),
      };

      // Validating selection with only /ws/A.java
      const selectedOnlyUpper = new Set([replaceMatchStableKey(matchUpperA)]);
      const filteredEditUpper = buildReplaceInFilesWorkspaceEdit({
        matches: [matchUpperA],
        replacementText: "bar",
      });
      const validUpper = validateReplacePreviewSelection(snapshot, selectedOnlyUpper, filteredEditUpper, edit);
      expect(validUpper.ok).toBe(true);

      // Swapping edit: sourceEdit only had /ws/A.java, but filteredEdit carries /ws/a.java
      const filteredEditLower = buildReplaceInFilesWorkspaceEdit({
        matches: [matchLowerA],
        replacementText: "bar",
      });
      const swappedResult = validateReplacePreviewSelection(snapshot, selectedOnlyUpper, filteredEditLower, filteredEditUpper);
      expect(swappedResult.ok).toBe(false);
      expect(swappedResult.reason).toContain("not part of the original replace plan");

      // Commit report summarizes applied vs failed across distinct files
      const outcomes = [
        { path: "/ws/A.java", status: "applied-disk" },
        { path: "/ws/a.java", status: "failed", reason: "permission denied" },
      ];
      const report = summarizeReplaceCommitReport(outcomes, [matchUpperA, matchLowerA]);
      expect(report.ok).toBe(false);
      expect(report.appliedCount).toBe(1);
      expect(report.fileCount).toBe(1);
      expect(report.plannedCount).toBe(2);
      expect(report.plannedFileCount).toBe(2);
      expect(report.blockers).toEqual(["/ws/a.java: permission denied"]);
      expect(report.message).toContain("1 of 2 occurrences in 1 of 2 files");
    });

    it("normalizes Windows drive letters, path separators, UNC paths, and file URIs consistently (ED-REPAIR-006-A2)", () => {
      // Windows drive casing and slash normalization
      const winKeyUpper = replacePreimagePathKey("C:\\Ws\\File.java");
      const winKeyLower = replacePreimagePathKey("c:/ws/file.java");
      const winKeyMixed = replacePreimagePathKey("C:/WS/FILE.JAVA");
      expect(winKeyUpper).toBe("c:/ws/file.java");
      expect(winKeyLower).toBe("c:/ws/file.java");
      expect(winKeyMixed).toBe("c:/ws/file.java");

      // Windows file:/// URI matches filesystem path key
      const winUriKeyUpper = replacePreimagePathKey("file:///C:/Ws/File.java");
      const winUriKeyLower = replacePreimagePathKey("file:///c:/ws/file.java");
      expect(winUriKeyUpper).toBe("c:/ws/file.java");
      expect(winUriKeyLower).toBe("c:/ws/file.java");

      // UNC paths
      const uncBackslash = replacePreimagePathKey("\\\\server\\share\\repo\\File.java");
      const uncSlash = replacePreimagePathKey("//server/share/repo/File.java");
      const uncUri = replacePreimagePathKey("file://server/share/repo/File.java");
      expect(uncBackslash).toBe("//server/share/repo/file.java");
      expect(uncSlash).toBe("//server/share/repo/file.java");
      expect(uncUri).toBe("//server/share/repo/file.java");

      // Multiple Windows matches referencing same canonical file group into one documentEdit
      const matchWin1: ReplaceInFilesMatch = {
        filePath: "C:\\Ws\\File.java",
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 3,
        matchedText: "foo",
      };
      const matchWin2: ReplaceInFilesMatch = {
        filePath: "c:/ws/file.java",
        startLine: 1,
        startCharacter: 0,
        endLine: 1,
        endCharacter: 3,
        matchedText: "foo",
      };
      const winEdit = buildReplaceInFilesWorkspaceEdit({
        matches: [matchWin1, matchWin2],
        replacementText: "bar",
      });
      expect(winEdit.documentEdits).toHaveLength(1);
      expect(winEdit.documentEdits[0]?.edits).toHaveLength(2);
    });

    it("rejects contradicting preimages for the same canonical path with an explicit conflict (ED-REPAIR-006-A2)", () => {
      const contradictingPreimages = [
        {
          path: "C:\\Ws\\File.java",
          uri: "file:///C:/Ws/File.java",
          textHash: "hash-alpha",
          encoding: "UTF-8",
          bom: false,
          eol: "crlf" as const,
          bufferRevision: null,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws",
        },
        {
          path: "c:/ws/file.java",
          uri: "file:///c:/ws/file.java",
          textHash: "hash-beta",
          encoding: "UTF-8",
          bom: false,
          eol: "crlf" as const,
          bufferRevision: null,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws",
        },
      ];

      expect(() => replacePreimageExpectedHashes({ preimages: contradictingPreimages })).toThrow(
        /Conflicting replace preimages for canonical path "c:\/ws\/file\.java"/,
      );

      // Duplicate entries with identical hashes succeed
      const consistentPreimages = [
        contradictingPreimages[0]!,
        { ...contradictingPreimages[1]!, textHash: "hash-alpha" },
      ];
      const hashes = replacePreimageExpectedHashes({ preimages: consistentPreimages });
      expect(hashes.size).toBe(1);
      expect(hashes.get("c:/ws/file.java")).toBe("hash-alpha");
    });
  });

  describe("ED-REPAIR-005: replace prepare request identity on snapshot", () => {
    it("attaches frozen ReplacePrepareRequestIdentity to ReplacePreviewSnapshot (ED-REPAIR-005-A3)", () => {
      const scopeIdentity: ReplaceScopeIdentity = {
        kind: "all",
        roots: ["/ws/repo"],
        explicitFiles: [],
        fileMask: null,
        generation: null,
      };
      const queryIdentity = {
        query: "oldName",
        caseSensitive: false,
        wholeWord: false,
        regexp: false,
        includeGlobs: [],
        excludeGlobs: [],
      };
      const matchKeys = sampleMatches.map(replaceMatchStableKey);
      const identity: ReplacePrepareRequestIdentity = {
        token: 42,
        workspaceInstanceId: "ws-instance-123",
        scope: scopeIdentity,
        query: queryIdentity,
        replacement: "newName",
        matchCount: 3,
        matchKeys,
        preparedAt: 123456789,
      };

      const snapshot: ReplacePreviewSnapshot = {
        scope: scopeIdentity,
        query: queryIdentity,
        replacement: "newName",
        matchKeys,
        matchCount: 3,
        editSignature: "sig-123",
        capturedAt: 123456789,
        preimages: [],
        requestIdentity: identity,
      };

      expect(snapshot.requestIdentity?.token).toBe(42);
      expect(snapshot.requestIdentity?.workspaceInstanceId).toBe("ws-instance-123");
      expect(snapshot.requestIdentity?.matchCount).toBe(3);
      expect(snapshot.requestIdentity?.matchKeys).toHaveLength(3);
      expect(snapshot.requestIdentity?.query.query).toBe("oldName");
      expect(snapshot.requestIdentity?.replacement).toBe("newName");
    });

    it("collects preimages successfully for clean files within roots (ED-REPAIR-005-A1, A3)", async () => {
      const roots = [{ path: "/ws/repo" }];
      const openBuffers: Record<string, { documentRevision: number | null; dirty: boolean; readOnly?: boolean }> = {
        "/ws/repo/src/FileA.ts": { documentRevision: 5, dirty: false },
      };
      const files: Record<string, { text: string; hash: string }> = {
        "src/FileA.ts": { text: "line 1\r\nline 2", hash: "hash-a" },
        "src/FileB.ts": { text: "line 1\nline 2", hash: "hash-b" },
      };

      const preimages = await collectReplacePreimages({
        paths: ["/ws/repo/src/FileA.ts", "/ws/repo/src/FileB.ts"],
        initialWorkspaceInstanceId: "ws-1",
        getCurrentWorkspaceInstanceId: () => "ws-1",
        getCurrentRoots: () => roots,
        getOpenFileState: (path) => openBuffers[path] ?? null,
        readFile: async (_root, rel) => files[rel]!,
      });

      expect(preimages).toHaveLength(2);
      expect(preimages[0]?.path).toBe("/ws/repo/src/FileA.ts");
      expect(preimages[0]?.textHash).toBe("hash-a");
      expect(preimages[0]?.eol).toBe("crlf");
      expect(preimages[0]?.bufferRevision).toBe(5);
      expect(preimages[0]?.dirty).toBe(false);
      expect(preimages[1]?.path).toBe("/ws/repo/src/FileB.ts");
      expect(preimages[1]?.textHash).toBe("hash-b");
      expect(preimages[1]?.eol).toBe("lf");
      expect(preimages[1]?.bufferRevision).toBeNull();
    });

    it("aborts immediately when signal is already aborted (ED-REPAIR-005-A1)", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          options: { signal: controller.signal },
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => ({ text: "", hash: "" }),
        }),
      ).rejects.toThrow("Replace preview cancelled");
    });

    it("aborts when signal fires during async disk read (ED-REPAIR-005-A1)", async () => {
      const controller = new AbortController();

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          options: { signal: controller.signal },
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => {
            controller.abort();
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow("Replace preview cancelled");
    });

    it("refuses when options workspaceInstanceId mismatches initial (ED-REPAIR-005-A2)", async () => {
      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          options: { workspaceInstanceId: "ws-old" },
          initialWorkspaceInstanceId: "ws-current",
          getCurrentWorkspaceInstanceId: () => "ws-current",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => ({ text: "", hash: "" }),
        }),
      ).rejects.toThrow("Replace preview refused: workspace instance mismatch");
    });

    it("aborts when workspace changes during prepare (ED-REPAIR-005-A2)", async () => {
      let currentWs = "ws-1";

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => currentWs,
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => {
            currentWs = "ws-2"; // Workspace switch occurred during read
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow("Replace preview cancelled: workspace changed during prepare");
    });

    it("refuses when buffer documentRevision is modified during prepare (ED-REPAIR-005-A2)", async () => {
      let revision = 10;

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => ({ documentRevision: revision, dirty: false }),
          readFile: async () => {
            revision = 11; // User edited document during prepare read
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow(/modified during prepare; please retry/);
    });

    it("refuses when buffer dirty state changes during prepare (ED-REPAIR-005-A2)", async () => {
      let dirty = false;

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => ({ documentRevision: 10, dirty }),
          readFile: async () => {
            dirty = true; // Buffer marked dirty during prepare read
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow(/modified during prepare; please retry/);
    });

    it("aborts when roots change during prepare (ED-REPAIR-005-A2)", async () => {
      let roots = [{ path: "/ws/repo" }];

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => roots,
          getOpenFileState: () => null,
          readFile: async () => {
            roots = [{ path: "/ws/other" }]; // Root configuration changed
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow("Replace preview cancelled: workspace state changed during prepare");
    });

    it("refuses when file path is outside roots (ED-REPAIR-005-A2)", async () => {
      await expect(
        collectReplacePreimages({
          paths: ["/outside/File.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => ({ text: "", hash: "" }),
        }),
      ).rejects.toThrow(/outside the workspace/);
    });
  });

  describe("ED-REPAIR-002: replace preflight and open buffer freeze conditions", () => {
    const sampleSnapshot: ReplacePreviewSnapshot = {
      scope: { kind: "workspace", roots: ["/ws"], explicitFiles: [], fileMask: null, generation: null },
      query: { query: "target", caseSensitive: false, wholeWord: false, regexp: false, includeGlobs: [], excludeGlobs: [] },
      replacement: "replacement",
      matchKeys: [
        "/ws/fileA.ts:0:0:0:6:target",
        "/ws/fileB.ts:0:0:0:6:target",
      ],
      matchCount: 2,
      editSignature: "sig-123",
      capturedAt: 1000,
      requestIdentity: {
        token: 1,
        workspaceInstanceId: "ws-1",
        scope: { kind: "workspace", roots: ["/ws"], explicitFiles: [], fileMask: null, generation: null },
        query: { query: "target", caseSensitive: false, wholeWord: false, regexp: false, includeGlobs: [], excludeGlobs: [] },
        replacement: "replacement",
        matchKeys: [
          "/ws/fileA.ts:0:0:0:6:target",
          "/ws/fileB.ts:0:0:0:6:target",
        ],
        matchCount: 2,
        preparedAt: 1000,
      },
      preimages: [
        {
          path: "/ws/fileA.ts",
          uri: "file:///ws/fileA.ts",
          textHash: "hash-a",
          encoding: "UTF-8",
          bom: false,
          eol: "lf",
          bufferRevision: 5,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws-1",
        },
        {
          path: "/ws/fileB.ts",
          uri: "file:///ws/fileB.ts",
          textHash: "hash-b",
          encoding: "UTF-8",
          bom: false,
          eol: "lf",
          bufferRevision: null,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws-1",
        },
      ],
    };

    it("validateReplacePreviewSelection rejects non-text resource operations (ED-REPAIR-002-A2)", () => {
      const editWithRename: any = {
        operations: [
          {
            kind: "text",
            document: {
              uri: "file:///ws/fileA.ts",
              path: "/ws/fileA.ts",
              edits: [
                { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
              ],
            },
          },
          {
            kind: "rename",
            oldUri: "file:///ws/fileB.ts",
            newUri: "file:///ws/fileB-renamed.ts",
          },
        ],
        documentEdits: [
          {
            uri: "file:///ws/fileA.ts",
            path: "/ws/fileA.ts",
            edits: [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
            ],
          },
        ],
      };

      const result = validateReplacePreviewSelection(
        sampleSnapshot,
        new Set(["/ws/fileA.ts:0:0:0:6:target"]),
        editWithRename,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Resource operations are not permitted");
    });

    it("validateReplacePreviewSelection rejects duplicate edits for same path/range (ED-REPAIR-002-A2)", () => {
      const editWithDuplicate: any = {
        documentEdits: [
          {
            uri: "file:///ws/fileA.ts",
            path: "/ws/fileA.ts",
            edits: [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
            ],
          },
        ],
      };

      const result = validateReplacePreviewSelection(
        sampleSnapshot,
        new Set(["/ws/fileA.ts:0:0:0:6:target", "/ws/fileB.ts:0:0:0:6:target"]),
        editWithDuplicate,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Duplicate edit detected");
    });

    it("validateReplacePreviewSelection rejects forged same-count edit not in sourceEdit (ED-REPAIR-002-A2)", () => {
      const sourceEdit: any = {
        documentEdits: [
          {
            uri: "file:///ws/fileA.ts",
            path: "/ws/fileA.ts",
            edits: [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
            ],
          },
        ],
      };
      const forgedEdit: any = {
        documentEdits: [
          {
            uri: "file:///ws/fileA.ts",
            path: "/ws/fileA.ts",
            edits: [
              { range: { start: { line: 10, character: 0 }, end: { line: 10, character: 6 } }, newText: "replacement" },
            ],
          },
        ],
      };

      const result = validateReplacePreviewSelection(
        sampleSnapshot,
        new Set(["/ws/fileA.ts:0:0:0:6:target"]),
        forgedEdit,
        sourceEdit,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not part of the original replace plan");
    });

    it("validateReplacePreflight accepts matching clean disk and buffer preimages (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
        {
          path: "/ws/fileB.ts",
          exists: true,
          diskHash: "hash-b",
          diskText: "target b",
          isOpen: false,
          openBufferRevision: null,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it("validateReplacePreflight rejects when workspace instance mismatches (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-switched", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].reason).toContain("workspace instance mismatch");
    });

    it("validateReplacePreflight rejects missing or unreadable file (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: false,
          diskHash: null,
          diskText: null,
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].reason).toContain("file not found on disk or unreadable");
    });

    it("validateReplacePreflight rejects disk hash change on file B (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
        {
          path: "/ws/fileB.ts",
          exists: true,
          diskHash: "hash-b-modified",
          diskText: "target b!",
          isOpen: false,
          openBufferRevision: null,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].path).toBe("/ws/fileB.ts");
      expect(result.conflicts[0].reason).toContain("changed on disk since the frozen replace preview");
    });

    it("validateReplacePreflight rejects open buffer revision mismatch (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 6,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].path).toBe("/ws/fileA.ts");
      expect(result.conflicts[0].reason).toContain("modified in the editor");
    });

    it("validateReplacePreflight rejects dirty open buffer (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: true,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].path).toBe("/ws/fileA.ts");
      expect(result.conflicts[0].reason).toContain("unsaved modifications in the editor");
    });

    it("validateReplacePreflight rejects read-only open buffer (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: true,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].path).toBe("/ws/fileA.ts");
      expect(result.conflicts[0].reason).toContain("read-only");
    });

    it("validateReplacePreflight rejects open/closed session flip (ED-REPAIR-002-A1)", () => {
      const fileBOpened: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileB.ts",
          exists: true,
          diskHash: "hash-b",
          diskText: "target b",
          isOpen: true,
          openBufferRevision: 1,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result1 = validateReplacePreflight(sampleSnapshot, "ws-1", fileBOpened);
      expect(result1.canCommit).toBe(false);
      expect(result1.conflicts[0].reason).toContain("was opened in the editor since the frozen preview");

      const fileAClosed: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: false,
          openBufferRevision: null,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result2 = validateReplacePreflight(sampleSnapshot, "ws-1", fileAClosed);
      expect(result2.canCommit).toBe(false);
      expect(result2.conflicts[0].reason).toContain("was closed in the editor since the frozen preview");
    });
  });
});


