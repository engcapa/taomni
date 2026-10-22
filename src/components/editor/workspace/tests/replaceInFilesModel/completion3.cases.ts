import { describe, expect, it } from "vitest";
import { planFindInFilesScope } from "../../findInFilesScopeModel";
import {
  buildReplaceInFilesWorkspaceEdit,
  createReplaceInFilesPlan,
  findReplacePreimage,
  replaceEditSignature,
  replaceMatchStableKey,
  replacePreimageExpectedHashes,
  replacePreimagePathKey,
  replaceScopeIdentityFromPlan,
  summarizeReplaceCommitReport,
  validateReplacePreviewSelection,
  type ReplaceInFilesMatch,
  type ReplacePreviewSnapshot,
} from "../../replaceInFilesModel";

export interface registerreplaceInFilesModelCompletion3CasesContext {
  sampleMatches: ReplaceInFilesMatch[];
  snapshotFor: (edit: ReturnType<typeof buildReplaceInFilesWorkspaceEdit>) => ReplacePreviewSnapshot;
}

export function registerreplaceInFilesModelCompletion3Cases(caseContext: registerreplaceInFilesModelCompletion3CasesContext) {

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
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: caseContext.sampleMatches, replacementText: "bar" });
    const same = buildReplaceInFilesWorkspaceEdit({ matches: caseContext.sampleMatches, replacementText: "bar" });
    const otherText = buildReplaceInFilesWorkspaceEdit({ matches: caseContext.sampleMatches, replacementText: "baz" });
    const otherRange = buildReplaceInFilesWorkspaceEdit({
      matches: caseContext.sampleMatches.map((match, index) => index === 0 ? { ...match, startCharacter: 1 } : match),
      replacementText: "bar",
    });
    expect(replaceEditSignature(edit)).toBe(replaceEditSignature(same));
    expect(replaceEditSignature(edit)).not.toBe(replaceEditSignature(otherText));
    expect(replaceEditSignature(edit)).not.toBe(replaceEditSignature(otherRange));
  });

  it("accepts a selected subset that stays inside the frozen snapshot", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: caseContext.sampleMatches, replacementText: "bar" });
    const snapshot = caseContext.snapshotFor(edit);
    const filtered = createReplaceInFilesPlan(edit, new Set(["0:0"])).filteredEdit;
    const subsetKeys = new Set(caseContext.sampleMatches.slice(1).map(replaceMatchStableKey));
    expect(validateReplacePreviewSelection(snapshot, subsetKeys, filtered)).toEqual({ ok: true });
  });

  it("rejects selections outside the snapshot, count drift and replacement drift", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: caseContext.sampleMatches, replacementText: "bar" });
    const snapshot = caseContext.snapshotFor(edit);
    const allKeys = new Set(caseContext.sampleMatches.map(replaceMatchStableKey));

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

    const driftedEdit = buildReplaceInFilesWorkspaceEdit({ matches: caseContext.sampleMatches, replacementText: "baz" });
    const driftedText = validateReplacePreviewSelection(snapshot, allKeys, driftedEdit);
    expect(driftedText.ok).toBe(false);
    expect(driftedText.reason).toContain("frozen replacement");
  });

  it("rejects a same-count selection whose path/range was swapped (ED-MAIN-005)", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: caseContext.sampleMatches, replacementText: "bar" });
    const snapshot = caseContext.snapshotFor(edit);
    const allKeys = new Set(caseContext.sampleMatches.map(replaceMatchStableKey));
    // Same number of edits and the frozen replacement, but one range moved.
    const swapped = buildReplaceInFilesWorkspaceEdit({
      matches: caseContext.sampleMatches.map((match, index) => (
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
}
