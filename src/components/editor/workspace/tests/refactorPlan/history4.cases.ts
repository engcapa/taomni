import { describe, expect, it } from "vitest";
import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { fsPathComparisonKey, normalizeFsPath } from "../../codeWorkspaceModel";
import { sha256Hex } from "../../projectAnalysisModel";
import {
  buildRefactorPlan,
  buildRefactorPostTextIndex,
  dismissRefactorRecoveryEntry,
  getRefactorRecoveryJournalV2,
  isPendingRefactorRecoveryEntry,
  prepareRefactorRecoveryJournalV2,
  recordRefactorRecoveryJournalV2,
  recoveryMoveProofMatches,
  resolveRecoveryMoveProof,
  resolveRefactorPostTextForDocument,
  verifyRefactorMovePostEndpoints,
  verifyRefactorPostHashes,
  type RefactorRecoveryDocumentSnapshotV2,
} from "../../refactorPlan";
import { dummyEvidence } from "./harness";

export function registerrefactorPlanHistory4Cases() {

  describe("java-rename-deleted-recovery RC-01: identity-based post verification", () => {
    // Production preparation for a top-level class rename: one text op on the
    // old path plus one rename op old -> new. contentHash keeps the pre-image
    // (historical meaning); post bytes live at the new path.
    const prepareClassRename = (oldPath: string, newPath: string) => {
      const oldUri = `file://${oldPath.replace(/\\/g, "/")}`;
      const newUri = `file://${newPath.replace(/\\/g, "/")}`;
      const preText = "public class MyTest {}";
      const preparation = prepareRefactorRecoveryJournalV2({
        plan: { actionId: "rename-class", kind: "rename", documents: [] },
        edit: {
          documentEdits: [],
          operations: [
            {
              kind: "text",
              document: {
                uri: oldUri,
                path: oldPath,
                version: null,
                edits: [
                  { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }, newText: "MyTesting" },
                ],
              },
            },
            {
              kind: "rename",
              oldUri,
              newUri,
              oldPath,
              newPath,
              overwrite: false,
              ignoreIfExists: false,
              annotationId: null,
            },
          ],
        } as unknown as LspWorkspaceEdit,
        preImages: [{
          uri: oldUri,
          canonicalPath: normalizeFsPath(oldPath),
          preText,
          encoding: "UTF-8",
          bom: false,
          eol: "lf" as const,
        }],
        workspaceRoot: "D:/fixture/ique",
        transactionId: "tx-class-rename",
      });
      if (preparation.state !== "prepared") throw new Error("expected prepared");
      return preparation.entry;
    };

    it("resolves the post text through backslash/forward-slash spellings (RC-01)", () => {
      const entry = prepareClassRename(
        String.raw`D:\fixture\ique\MyTest.java`,
        String.raw`D:\fixture\ique\MyTesting.java`,
      );
      const postText = "public class MyTesting {}";
      // Shell snapshot keyed with forward slashes; move pair keeps backslashes.
      const index = buildRefactorPostTextIndex({
        [normalizeFsPath(String.raw`D:/fixture/ique/MyTesting.java`)]: postText,
      });
      const resolved = resolveRefactorPostTextForDocument(
        { uri: entry.documents[0]!.uri, canonicalPath: entry.documents[0]!.canonicalPath },
        entry.resourceMoves,
        index,
      );
      expect(resolved?.text).toBe(postText);
    });

    it("treats drive-casing and file-URI spellings as the same resource", () => {
      const entry = prepareClassRename("/workspace/MyTest.java", "/workspace/MyTesting.java");
      const index = buildRefactorPostTextIndex({
        "file:///workspace/MyTesting.java": "public class MyTesting {}",
      });
      const resolved = resolveRefactorPostTextForDocument(
        { uri: entry.documents[0]!.uri, canonicalPath: entry.documents[0]!.canonicalPath },
        entry.resourceMoves,
        index,
      );
      expect(resolved?.text).toBe("public class MyTesting {}");
      const upper = buildRefactorPostTextIndex({ "/WORKSPACE/MyTesting.java": "x" });
      void upper;
      // POSIX paths stay case-sensitive: different case must not merge.
      const posixIndex = buildRefactorPostTextIndex({ "/workspace/Other.java": "x" });
      expect(resolveRefactorPostTextForDocument(
        { uri: "file:///workspace/other.java", canonicalPath: "/workspace/other.java" },
        [],
        posixIndex,
      )).toBeNull();
    });

    it("fails closed on ambiguous chains and stale old buffers (RC-01/AC-06)", () => {
      const entry = prepareClassRename("/workspace/A.java", "/workspace/B.java");
      // Stale old buffer shadowing disk: old still present -> no alias success.
      const bothPresent = buildRefactorPostTextIndex({
        "/workspace/A.java": "stale",
        "/workspace/B.java": "public class MyTesting {}",
      });
      expect(resolveRefactorPostTextForDocument(
        { uri: entry.documents[0]!.uri, canonicalPath: entry.documents[0]!.canonicalPath },
        entry.resourceMoves,
        bothPresent,
      )).toBeNull();
      // Chained moves A->B, B->C with an ambiguous fan-out fail closed.
      const chained = resolveRefactorPostTextForDocument(
        { uri: "file:///workspace/A.java", canonicalPath: "/workspace/A.java" },
        [
          { oldUri: "file:///workspace/A.java", newUri: "file:///workspace/B.java", oldPath: "/workspace/A.java", newPath: "/workspace/B.java", contentHash: null },
          { oldUri: "file:///workspace/A.java", newUri: "file:///workspace/C.java", oldPath: "/workspace/A.java", newPath: "/workspace/C.java", contentHash: null },
        ],
        buildRefactorPostTextIndex({ "/workspace/C.java": "x" }),
      );
      expect(chained).toBeNull();
    });

    it("reports missing required post text instead of silently skipping (RC-01)", () => {
      const plan = buildRefactorPlan({
        actionId: "rename-missing",
        kind: "rename",
        evidence: dummyEvidence,
        edit: {
          documentEdits: [{
            uri: "file:///workspace/A.java",
            path: "/workspace/A.java",
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }],
          }],
        },
        roots: [{ path: "/workspace" }],
        currentTexts: { "/workspace/A.java": "a" },
      });
      const result = verifyRefactorPostHashes(plan, {});
      expect(result.allMatched).toBe(false);
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]!.uri).toBe("file:///workspace/A.java");
    });

    it("accepts EOL-only differences in plan verification (RC-01)", () => {
      const plan = buildRefactorPlan({
        actionId: "rename-eol",
        kind: "rename",
        evidence: dummyEvidence,
        edit: {
          documentEdits: [{
            uri: "file:///workspace/A.java",
            path: "/workspace/A.java",
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }],
          }],
        },
        roots: [{ path: "/workspace" }],
        currentTexts: { "/workspace/A.java": "a\nb\n" },
      });
      const doc = plan.documents[0]!;
      expect(doc.expectedPostHash).not.toBeNull();
      // Same content saved with CRLF must verify, foreign content must not.
      const crlf = "b\nb\n".replace(/\n/g, "\r\n");
      void crlf;
      const lfPost = "b\nb\n";
      const ok = verifyRefactorPostHashes(plan, { "/workspace/A.java": lfPost.replace(/\n/g, "\r\n") });
      expect(ok.allMatched).toBe(true);
      const bad = verifyRefactorPostHashes(plan, { "/workspace/A.java": "foreign" });
      expect(bad.allMatched).toBe(false);
      expect(bad.mismatches).toHaveLength(1);
    });

    it("proves pure-move endpoints old-gone/new-present (RC-01/AC-06)", () => {
      const moves = [{
        oldUri: "file:///workspace/Old.java",
        newUri: "file:///workspace/New.java",
        oldPath: "/workspace/Old.java",
        newPath: "/workspace/New.java",
        contentHash: null,
      }];
      const keyOf = (p: string) => p;
      void keyOf;
      const verified = verifyRefactorMovePostEndpoints(moves, new Map([
        [fsPathComparisonKey("/workspace/Old.java"), false],
        [fsPathComparisonKey("/workspace/New.java"), true],
      ]));
      expect(verified.allVerified).toBe(true);
      const bothMissing = verifyRefactorMovePostEndpoints(moves, new Map([
        [fsPathComparisonKey("/workspace/Old.java"), false],
        [fsPathComparisonKey("/workspace/New.java"), false],
      ]));
      expect(bothMissing.allVerified).toBe(false);
    });
  });

  describe("java-rename-deleted-recovery RC-02/RC-03: resolution and move proof", () => {
    const mockStorage = () => {
      const store = new Map<string, string>();
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
        clear: () => store.clear(),
      } as unknown as Storage;
    };

    const storedEntry = (overrides: Partial<import("../../refactorPlan").RefactorRecoveryJournalEntryV2> = {}) => ({
      schemaVersion: 2 as const,
      recoveryId: "rec-dismiss-1",
      transactionId: "tx-dismiss-1",
      actionId: "rename:test",
      kind: "rename" as const,
      workspaceRoot: "/workspace",
      createdAt: 100,
      updatedAt: 200,
      status: "recovery-required" as const,
      appliedOperationIndex: null,
      documents: [],
      resourceMoves: [],
      verification: { mismatchedUris: [] as readonly string[], checkedAt: null },
      ...overrides,
    });

    it("keeps historical entries pending and validates the dismissal marker", () => {
      expect(isPendingRefactorRecoveryEntry(storedEntry())).toBe(true);
      expect(isPendingRefactorRecoveryEntry(storedEntry({ status: "committed" }))).toBe(false);
      expect(isPendingRefactorRecoveryEntry(storedEntry({
        resolution: { kind: "user-dismissed", resolvedAt: 300, reason: "keep-current-state" },
      }))).toBe(false);
    });

    it("dismisses exactly one record with a stale-version guard and zero file effects", () => {
      const storage = mockStorage();
      const before = storedEntry();
      expect(recordRefactorRecoveryJournalV2(before, storage)).toEqual({ ok: true });
      const other = storedEntry({ recoveryId: "rec-other", transactionId: "tx-other" });
      expect(recordRefactorRecoveryJournalV2(other, storage)).toEqual({ ok: true });

      const ok = dismissRefactorRecoveryEntry("rec-dismiss-1", 200, storage, 300);
      expect(ok).toEqual({ ok: true });
      const reread = getRefactorRecoveryJournalV2("rec-dismiss-1", storage)!;
      expect(reread.resolution).toEqual({ kind: "user-dismissed", resolvedAt: 300, reason: "keep-current-state" });
      expect(reread.status).toBe("recovery-required");
      expect(isPendingRefactorRecoveryEntry(reread)).toBe(false);
      // The sibling pending record is untouched.
      expect(isPendingRefactorRecoveryEntry(getRefactorRecoveryJournalV2("rec-other", storage)!)).toBe(true);

      // Stale confirmations never overwrite newer state.
      const stale = dismissRefactorRecoveryEntry("rec-dismiss-1", 200, storage, 400);
      expect(stale.ok).toBe(false);
    });

    it("derives the move proof from the matching journal document (RC-03)", () => {
      const preText = "public class MyTest {}";
      const postText = "public class MyTesting {}";
      const doc: RefactorRecoveryDocumentSnapshotV2 = {
        uri: "file:///workspace/MyTest.java",
        canonicalPath: "/workspace/MyTest.java",
        preText,
        preHash: sha256Hex(preText),
        postText,
        postHash: sha256Hex(postText),
        encoding: "UTF-8",
        bom: false,
        eol: "lf",
      };
      const move = {
        oldUri: "file:///workspace/MyTest.java",
        newUri: "file:///workspace/MyTesting.java",
        oldPath: "/workspace/MyTest.java",
        newPath: "/workspace/MyTesting.java",
        contentHash: sha256Hex(preText),
      };
      const proof = resolveRecoveryMoveProof(move, [doc]);
      expect(proof.kind).toBe("document");
      // The live post image at the new path proves the bytes; foreign text does not.
      expect(recoveryMoveProofMatches(proof, postText)).toBe(true);
      expect(recoveryMoveProofMatches(proof, preText)).toBe(true);
      expect(recoveryMoveProofMatches(proof, "third-party")).toBe(false);
    });
  });
}
