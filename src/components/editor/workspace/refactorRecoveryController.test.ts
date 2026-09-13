import { describe, expect, it } from "vitest";
import {
  classifyRefactorRecoveryPreconditions,
  createRestoreEchoSuppressor,
  executeRefactorRecovery,
  RESTORE_ECHO_SUPPRESS_WINDOW_MS,
} from "./refactorRecoveryController";
import { prepareRefactorRecoveryJournalV2 } from "./refactorPlan";
import { normalizeFsPath } from "./codeWorkspaceModel";
import { sha256Hex } from "./projectAnalysisModel";
import type { RefactorRecoveryJournalEntryV2 } from "./refactorPlan";

const entry = (documents: Array<{
  uri: string;
  canonicalPath: string;
  preText: string;
  postText: string;
}>): RefactorRecoveryJournalEntryV2 => ({
  schemaVersion: 2,
  recoveryId: "rec-test",
  transactionId: "tx-test",
  actionId: "rename:test",
  kind: "rename",
  workspaceRoot: "/workspace",
  createdAt: 1,
  updatedAt: 1,
  status: "recovery-required",
  appliedOperationIndex: null,
  documents: documents.map((doc) => ({
    ...doc,
    preHash: sha256Hex(doc.preText),
    postHash: sha256Hex(doc.postText),
    encoding: "UTF-8",
    bom: false,
    eol: "lf" as const,
  })),
  resourceMoves: [],
  verification: { mismatchedUris: [], checkedAt: null },
});

const twoDocEntry = entry([
  { uri: "file:///workspace/A.java", canonicalPath: "/workspace/A.java", preText: "alpha", postText: "nextAlpha" },
  { uri: "file:///workspace/B.java", canonicalPath: "/workspace/B.java", preText: "beta", postText: "nextBeta" },
]);

describe("ED-AUDIT-014: refactor recovery controller", () => {
  describe("classifyRefactorRecoveryPreconditions", () => {
    it("classifies restorable, already-restored, conflict, and unreadable states", async () => {
      const summary = await classifyRefactorRecoveryPreconditions(twoDocEntry, async (path) => {
        if (path === "/workspace/A.java") return { text: "nextAlpha" }; // postHash -> restorable
        if (path === "/workspace/B.java") return { text: "beta" }; // preHash -> already-restored
        return null;
      });
      expect(summary.documents[0].state).toBe("restorable");
      expect(summary.documents[1].state).toBe("already-restored");
      expect(summary.overall).toBe("restorable");
    });

    it("marks third-party content as conflict with zero-overwrite semantics", async () => {
      const summary = await classifyRefactorRecoveryPreconditions(twoDocEntry, async (path) => {
        if (path === "/workspace/A.java") return { text: "nextAlpha" };
        return { text: "third-party edit" };
      });
      expect(summary.documents[1].state).toBe("conflict");
      expect(summary.documents[1].currentHash).toBe(sha256Hex("third-party edit"));
      expect(summary.overall).toBe("conflict");
    });

    it("marks unreadable files and lets unreadable dominate restorable", async () => {
      const summary = await classifyRefactorRecoveryPreconditions(twoDocEntry, async (path) => {
        if (path === "/workspace/A.java") return { text: "nextAlpha" };
        throw new Error("disk error");
      });
      expect(summary.documents[1].state).toBe("unreadable");
      expect(summary.overall).toBe("unreadable");
    });

    it("reports already-restored when every document is at its preimage", async () => {
      const summary = await classifyRefactorRecoveryPreconditions(twoDocEntry, async (path) => {
        return { text: path === "/workspace/A.java" ? "alpha" : "beta" };
      });
      expect(summary.overall).toBe("already-restored");
    });
  });

  describe("executeRefactorRecovery", () => {
    it("restores restorable documents and confirms every preHash via read-back", async () => {
      const writes: string[] = [];
      const execution = await executeRefactorRecovery(twoDocEntry, await classifyRefactorRecoveryPreconditions(
        twoDocEntry,
        async (path) => ({ text: path === "/workspace/A.java" ? "nextAlpha" : "nextBeta" }),
      ), {
        restoreText: async (doc) => {
          writes.push(doc.canonicalPath ?? doc.uri);
        },
        readBack: async (doc) => ({ text: doc.preText }),
      });
      expect(execution.state).toBe("rolled-back");
      expect(execution.restoredUris).toEqual([
        "file:///workspace/A.java",
        "file:///workspace/B.java",
      ]);
      expect(execution.conflicts).toHaveLength(0);
      expect(execution.failures).toHaveLength(0);
      expect(writes).toHaveLength(2);
    });

    it("never writes conflicted documents and keeps the entry pending", async () => {
      const writes: string[] = [];
      const execution = await executeRefactorRecovery(twoDocEntry, await classifyRefactorRecoveryPreconditions(
        twoDocEntry,
        async (path) => ({ text: path === "/workspace/A.java" ? "nextAlpha" : "third-party" }),
      ), {
        restoreText: async (doc) => {
          writes.push(doc.canonicalPath ?? doc.uri);
        },
        readBack: async (doc) => ({ text: doc.preText }),
      });
      expect(execution.state).toBe("pending");
      expect(writes).toEqual(["/workspace/A.java"]);
      expect(execution.conflicts).toHaveLength(1);
      expect(execution.conflicts[0].canonicalPath).toBe("/workspace/B.java");
      expect(execution.restoredUris).toEqual(["file:///workspace/A.java"]);
    });

    it("keeps pending state when a read-back hash does not confirm the preimage", async () => {
      const execution = await executeRefactorRecovery(twoDocEntry, await classifyRefactorRecoveryPreconditions(
        twoDocEntry,
        async (path) => ({ text: path === "/workspace/A.java" ? "nextAlpha" : "nextBeta" }),
      ), {
        restoreText: async () => undefined,
        readBack: async (doc) => ({ text: doc.canonicalPath === "/workspace/A.java" ? "corrupted" : doc.preText }),
      });
      expect(execution.state).toBe("pending");
      expect(execution.restoredUris).toEqual(["file:///workspace/B.java"]);
      expect(execution.failures).toHaveLength(1);
      expect(execution.failures[0].reason).toContain("read-back hash");
    });

    it("keeps pending state when the restore write throws", async () => {
      const execution = await executeRefactorRecovery(twoDocEntry, await classifyRefactorRecoveryPreconditions(
        twoDocEntry,
        async (path) => ({ text: path === "/workspace/A.java" ? "nextAlpha" : "nextBeta" }),
      ), {
        restoreText: async (doc) => {
          throw new Error(`write failed for ${doc.canonicalPath}`);
        },
        readBack: async (doc) => ({ text: doc.preText }),
      });
      expect(execution.state).toBe("pending");
      expect(execution.restoredUris).toHaveLength(0);
      expect(execution.failures).toHaveLength(2);
      expect(execution.failures[0].reason).toContain("write failed");
    });

    it("is idempotent: a re-run over restored content skips writes and reports rolled-back", async () => {
      const writes: string[] = [];
      const preconditions = await classifyRefactorRecoveryPreconditions(
        twoDocEntry,
        async (path) => ({ text: path === "/workspace/A.java" ? "alpha" : "beta" }),
      );
      expect(preconditions.overall).toBe("already-restored");
      const execution = await executeRefactorRecovery(twoDocEntry, preconditions, {
        restoreText: async (doc) => {
          writes.push(doc.canonicalPath ?? doc.uri);
        },
        readBack: async (doc) => ({ text: doc.preText }),
      });
      expect(execution.state).toBe("rolled-back");
      expect(execution.restoredUris).toHaveLength(0);
      expect(execution.skippedUris).toHaveLength(2);
      expect(writes).toHaveLength(0);
    });

    it("reports rolled-back only when every document is confirmed at its preHash", async () => {
      const execution = await executeRefactorRecovery(twoDocEntry, await classifyRefactorRecoveryPreconditions(
        twoDocEntry,
        async (path) => (path === "/workspace/A.java" ? { text: "nextAlpha" } : { text: "beta" }),
      ), {
        restoreText: async () => undefined,
        readBack: async (doc) => ({ text: doc.preText }),
      });
      // A: restorable -> restored; B: already-restored -> skipped. All confirmed.
      expect(execution.state).toBe("rolled-back");
      expect(execution.restoredUris).toEqual(["file:///workspace/A.java"]);
      expect(execution.skippedUris).toEqual(["file:///workspace/B.java"]);

      // One unreadable document breaks completeness.
      const partial = await executeRefactorRecovery(twoDocEntry, {
        documents: [
          { uri: "file:///workspace/A.java", canonicalPath: "/workspace/A.java", state: "restorable", currentHash: null },
          { uri: "file:///workspace/B.java", canonicalPath: "/workspace/B.java", state: "unreadable", currentHash: null },
        ],
        moves: [],
        overall: "unreadable",
      }, {
        restoreText: async () => undefined,
        readBack: async (doc) => ({ text: doc.preText }),
      });
      expect(partial.state).toBe("pending");
      expect(partial.failures[0].uri).toBe("file:///workspace/B.java");
    });
  });

  describe("ED-FOLLOW-001: journalled file moves", () => {
    const moveEntry = (
      moves: RefactorRecoveryJournalEntryV2["resourceMoves"],
      documents: Array<{ uri: string; canonicalPath: string; preText: string; postText: string }> = [],
    ): RefactorRecoveryJournalEntryV2 => ({
      ...entry(documents),
      recoveryId: "rec-move-test",
      resourceMoves: moves,
    });
    const movedFile = {
      oldUri: "file:///workspace/Old.java",
      newUri: "file:///workspace/New.java",
      oldPath: "/workspace/Old.java",
      newPath: "/workspace/New.java",
      contentHash: sha256Hex("moved-bytes"),
    };
    // Post-move disk: old gone, new present with the journalled bytes.
    const postMoveRead = async (path: string) => (
      path === "/workspace/New.java" ? { text: "moved-bytes" } : null
    );

    it("classifies a completed move as restorable and resolves the doc target to the new path", async () => {
      const docEntry = moveEntry([movedFile], [
        { uri: "file:///workspace/Old.java", canonicalPath: "/workspace/Old.java", preText: "pre-bytes", postText: "moved-bytes" },
      ]);
      const summary = await classifyRefactorRecoveryPreconditions(docEntry, postMoveRead);
      expect(summary.moves).toHaveLength(1);
      expect(summary.moves[0].state).toBe("restorable");
      expect(summary.moves[0].currentHash).toBe(sha256Hex("moved-bytes"));
      // The text document addressed to the pre-move path classifies against
      // the moved bytes (postHash) instead of going unreadable.
      expect(summary.documents[0].state).toBe("restorable");
      expect(summary.overall).toBe("restorable");
    });

    it("classifies already-restored, both-present, both-missing, and drifted-content moves", async () => {
      const docless = moveEntry([movedFile]);
      const home = await classifyRefactorRecoveryPreconditions(docless, async (path) => (
        path === "/workspace/Old.java" ? { text: "moved-bytes" } : null
      ));
      expect(home.moves[0].state).toBe("already-restored");
      expect(home.overall).toBe("already-restored");

      const bothPresent = await classifyRefactorRecoveryPreconditions(docless, async () => ({ text: "moved-bytes" }));
      expect(bothPresent.moves[0].state).toBe("conflict");
      expect(bothPresent.overall).toBe("conflict");

      const bothMissing = await classifyRefactorRecoveryPreconditions(docless, async () => null);
      expect(bothMissing.moves[0].state).toBe("conflict");

      const drifted = await classifyRefactorRecoveryPreconditions(docless, async (path) => (
        path === "/workspace/New.java" ? { text: "third-party-rewrite" } : null
      ));
      expect(drifted.moves[0].state).toBe("conflict");
      expect(drifted.moves[0].currentHash).toBe(sha256Hex("third-party-rewrite"));
    });

    it("reverses the move before text documents and verifies old-present, new-gone, content proof", async () => {
      const docEntry = moveEntry([movedFile], [
        { uri: "file:///workspace/Old.java", canonicalPath: "/workspace/Old.java", preText: "pre-bytes", postText: "moved-bytes" },
      ]);
      const disk = new Map<string, string>([["/workspace/New.java", "moved-bytes"]]);
      const reversed: string[] = [];
      const writes: string[] = [];
      const execution = await executeRefactorRecovery(docEntry, await classifyRefactorRecoveryPreconditions(
        docEntry,
        async (path) => {
          const text = disk.get(path);
          return text === undefined ? null : { text };
        },
        { pathExists: async (path) => disk.has(path) },
      ), {
        restoreText: async (doc) => {
          const target = doc.canonicalPath ?? doc.uri;
          disk.set(target, doc.preText);
          writes.push(target);
        },
        readBack: async (doc) => {
          const text = disk.get(doc.canonicalPath ?? doc.uri);
          return text === undefined ? null : { text };
        },
        reverseResourceMove: async (move) => {
          const text = disk.get(move.newPath!);
          if (text === undefined) throw new Error("new path missing");
          disk.delete(move.newPath!);
          disk.set(move.oldPath!, text);
          reversed.push(move.newPath!);
        },
        pathExists: async (path) => disk.has(path),
        readMoveText: async (path) => {
          const text = disk.get(path);
          return text === undefined ? null : { text };
        },
      });
      expect(execution.state).toBe("rolled-back");
      expect(reversed).toEqual(["/workspace/New.java"]);
      expect(execution.reversedMoves).toEqual(["/workspace/New.java"]);
      expect(execution.contentUnverifiedMoves).toHaveLength(0);
      // The text document restored the moved-home bytes to the preimage.
      expect(writes).toEqual(["/workspace/Old.java"]);
      expect(disk.get("/workspace/Old.java")).toBe("pre-bytes");
      expect(disk.has("/workspace/New.java")).toBe(false);
      expect(execution.moveConflicts).toHaveLength(0);
      expect(execution.moveFailures).toHaveLength(0);
    });

    it("reports a content-unverified reversal without a content proof, and fails a broken reversal", async () => {
      const proofLess = moveEntry([{ ...movedFile, contentHash: null }]);
      const disk = new Map<string, string>([["/workspace/New.java", "moved-bytes"]]);
      const unverified = await executeRefactorRecovery(proofLess, await classifyRefactorRecoveryPreconditions(
        proofLess,
        async (path) => {
          const text = disk.get(path);
          return text === undefined ? null : { text };
        },
        { pathExists: async (path) => disk.has(path) },
      ), {
        restoreText: async () => undefined,
        readBack: async () => null,
        reverseResourceMove: async (move) => {
          disk.delete(move.newPath!);
          disk.set(move.oldPath!, "moved-bytes");
        },
        pathExists: async (path) => disk.has(path),
        readMoveText: async (path) => {
          const text = disk.get(path);
          return text === undefined ? null : { text };
        },
      });
      expect(unverified.state).toBe("rolled-back");
      expect(unverified.reversedMoves).toEqual(["/workspace/New.java"]);
      expect(unverified.contentUnverifiedMoves).toEqual(["/workspace/New.java"]);

      const brokenDisk = new Map<string, string>([["/workspace/New.java", "moved-bytes"]]);
      const broken = await executeRefactorRecovery(proofLess, await classifyRefactorRecoveryPreconditions(
        proofLess,
        async (path) => {
          const text = brokenDisk.get(path);
          return text === undefined ? null : { text };
        },
        { pathExists: async (path) => brokenDisk.has(path) },
      ), {
        restoreText: async () => undefined,
        readBack: async () => null,
        // Reversal forgets to delete the new path: verification must fail it.
        reverseResourceMove: async (move) => {
          brokenDisk.set(move.oldPath!, "moved-bytes");
        },
        pathExists: async (path) => brokenDisk.has(path),
        readMoveText: async (path) => {
          const text = brokenDisk.get(path);
          return text === undefined ? null : { text };
        },
      });
      expect(broken.state).toBe("pending");
      expect(broken.reversedMoves).toHaveLength(0);
      expect(broken.moveFailures).toHaveLength(1);
      expect(broken.moveFailures[0].reason).toContain("left the new path behind");
    });

    it("refuses the reversal when the shell cannot reverse moves, and treats moves in completeness", async () => {
      const docless = moveEntry([movedFile]);
      const refused = await executeRefactorRecovery(docless, await classifyRefactorRecoveryPreconditions(
        docless, postMoveRead,
      ), {
        restoreText: async () => undefined,
        readBack: async () => null,
      });
      expect(refused.state).toBe("pending");
      expect(refused.moveFailures).toHaveLength(1);
      expect(refused.moveFailures[0].reason).toContain("cannot reverse file moves");
    });
  });

  describe("createRestoreEchoSuppressor", () => {
    it("suppresses the watcher echo of a just-restored path exactly once", () => {
      const suppressor = createRestoreEchoSuppressor();
      expect(suppressor.shouldSuppress("/workspace/A.java", 1000)).toBe(false);
      suppressor.markRestored("/workspace/A.java", 1000);
      expect(suppressor.shouldSuppress("/workspace/A.java", 1000)).toBe(true);
      // The mark is consumed: a second echo for the same write reports.
      expect(suppressor.shouldSuppress("/workspace/A.java", 1001)).toBe(false);
    });

    it("lets a genuinely later third-party change report normally", () => {
      const suppressor = createRestoreEchoSuppressor();
      suppressor.markRestored("/workspace/A.java", 1000);
      expect(suppressor.shouldSuppress("/workspace/A.java", 1000 + RESTORE_ECHO_SUPPRESS_WINDOW_MS + 1)).toBe(false);
    });

    it("scopes marks per path and rejects clock skew", () => {
      const suppressor = createRestoreEchoSuppressor();
      suppressor.markRestored("/workspace/A.java", 2000);
      expect(suppressor.shouldSuppress("/workspace/B.java", 2000)).toBe(false);
      expect(suppressor.shouldSuppress("/workspace/A.java", 2000)).toBe(true);
      // A pre-mark timestamp never matches; the failed check still consumes.
      suppressor.markRestored("/workspace/C.java", 2000);
      expect(suppressor.shouldSuppress("/workspace/C.java", 1999)).toBe(false);
      expect(suppressor.shouldSuppress("/workspace/C.java", 2000)).toBe(false);
    });
  });

  describe("java-rename-deleted-recovery: production preparation for class rename", () => {
    const oldPath = "/workspace/MyTest.java";
    const newPath = "/workspace/MyTesting.java";
    const oldUri = "file:///workspace/MyTest.java";
    const newUri = "file:///workspace/MyTesting.java";
    const preText = "public class MyTest {}";
    const postText = "public class MyTesting {}";

    const preparedEntry = (): RefactorRecoveryJournalEntryV2 => {
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
        } as unknown as import("../../../lib/editor/lsp").LspWorkspaceEdit,
        preImages: [{
          uri: oldUri,
          canonicalPath: normalizeFsPath(oldPath),
          preText,
          encoding: "UTF-8",
          bom: false,
          eol: "lf" as const,
        }],
        workspaceRoot: "/workspace",
        transactionId: "tx-class",
      });
      if (preparation.state !== "prepared") throw new Error("expected prepared");
      return preparation.entry;
    };

    it("classifies the completed rename as restorable via the post image (RC-03)", async () => {
      const journal = preparedEntry();
      // contentHash keeps the historical pre-image meaning.
      expect(journal.resourceMoves[0]!.contentHash).toBe(sha256Hex(preText));
      // Post-move disk: old gone, new present with the POST bytes.
      const disk = new Map([[normalizeFsPath(newPath), postText]]);
      const summary = await classifyRefactorRecoveryPreconditions(
        journal,
        async (path) => {
          for (const [k, v] of disk) {
            if (normalizeFsPath(k) === normalizeFsPath(path)) return { text: v };
          }
          return null;
        },
        { pathExists: async (path) => [...disk.keys()].some((k) => normalizeFsPath(k) === normalizeFsPath(path)) },
      );
      expect(summary.moves[0]!.state).toBe("restorable");
      expect(summary.documents[0]!.state).toBe("restorable");
      expect(summary.overall).toBe("restorable");
    });

    it("reports both-missing as conflict/unreadable and never auto-resolves deletion (RC-02)", async () => {
      const journal = preparedEntry();
      const summary = await classifyRefactorRecoveryPreconditions(
        journal,
        async () => null,
        { pathExists: async () => false },
      );
      expect(summary.moves[0]!.state).toBe("conflict");
      expect(summary.moves[0]!.detail).toBe("both-missing");
      expect(summary.documents[0]!.state).toBe("unreadable");
      expect(summary.overall).toBe("conflict");
    });

    it("restores path and content with byte-preservation proof, idempotently (RC-03/AC-05)", async () => {
      const journal = preparedEntry();
      const disk = new Map([[newPath, postText]]);
      const preconditions = await classifyRefactorRecoveryPreconditions(
        journal,
        async (path) => (disk.get(path) === undefined ? null : { text: disk.get(path)! }),
        { pathExists: async (path) => disk.has(path) },
      );
      expect(preconditions.overall).toBe("restorable");
      const execution = await executeRefactorRecovery(journal, preconditions, {
        restoreText: async (doc) => {
          disk.set(doc.canonicalPath ?? doc.uri, doc.preText);
        },
        readBack: async (doc) => {
          const text = disk.get(doc.canonicalPath ?? doc.uri);
          return text === undefined ? null : { text };
        },
        reverseResourceMove: async (move) => {
          const text = disk.get(move.newPath!);
          if (text === undefined) throw new Error("new path missing");
          disk.delete(move.newPath!);
          disk.set(move.oldPath!, text);
        },
        pathExists: async (path) => disk.has(path),
        readMoveText: async (path) => {
          const text = disk.get(path);
          return text === undefined ? null : { text };
        },
      });
      expect(execution.state).toBe("rolled-back");
      expect(execution.reversedMoves).toEqual([newPath]);
      expect(disk.get(oldPath)).toBe(preText);
      expect(disk.has(newPath)).toBe(false);
      // Re-running over restored content skips writes (idempotent).
      const again = await classifyRefactorRecoveryPreconditions(
        journal,
        async (path) => (disk.get(path) === undefined ? null : { text: disk.get(path)! }),
        { pathExists: async (path) => disk.has(path) },
      );
      expect(again.overall).toBe("already-restored");
    });

    it("skips linked text writes when the move reversal fails (RC-03/AC-06)", async () => {
      const journal = preparedEntry();
      const disk = new Map([[newPath, postText]]);
      const preconditions = await classifyRefactorRecoveryPreconditions(
        journal,
        async (path) => (disk.get(path) === undefined ? null : { text: disk.get(path)! }),
        { pathExists: async (path) => disk.has(path) },
      );
      const writes: string[] = [];
      const execution = await executeRefactorRecovery(journal, preconditions, {
        restoreText: async (doc) => {
          writes.push(doc.canonicalPath ?? doc.uri);
        },
        readBack: async (doc) => {
          const text = disk.get(doc.canonicalPath ?? doc.uri);
          return text === undefined ? null : { text };
        },
        // Broken reversal: leaves the new path behind.
        reverseResourceMove: async (move) => {
          disk.set(move.oldPath!, postText);
        },
        pathExists: async (path) => disk.has(path),
        readMoveText: async (path) => {
          const text = disk.get(path);
          return text === undefined ? null : { text };
        },
      });
      expect(execution.state).toBe("pending");
      expect(execution.moveFailures).toHaveLength(1);
      expect(writes).toHaveLength(0);
      expect(execution.failures[0]!.reason).toContain("associated file move failed");
    });
  });
});
