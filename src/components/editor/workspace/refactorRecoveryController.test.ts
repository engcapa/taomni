import { describe, expect, it } from "vitest";
import {
  classifyRefactorRecoveryPreconditions,
  executeRefactorRecovery,
} from "./refactorRecoveryController";
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
        overall: "unreadable",
      }, {
        restoreText: async () => undefined,
        readBack: async (doc) => ({ text: doc.preText }),
      });
      expect(partial.state).toBe("pending");
      expect(partial.failures[0].uri).toBe("file:///workspace/B.java");
    });
  });
});
