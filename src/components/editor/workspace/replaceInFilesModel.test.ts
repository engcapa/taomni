import { describe, expect, it } from "vitest";
import {
  buildReplaceInFilesWorkspaceEdit,
  codePointOffsetToUtf16Offset,
  createReplaceInFilesPlan,
  searchMatchesToReplaceInputs,
  summarizeReplaceCommitReport,
  validateReplacePreconditions,
  verifyReplaceMatchFreshness,
  type ReplaceInFilesMatch,
} from "./replaceInFilesModel";
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
