import { describe, expect, it } from "vitest";
import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { sha256Hex } from "../../projectAnalysisModel";
import type { ProjectStructureSnapshotV2 } from "../../projectStructureModel";
import {
  buildRefactorPlan,
  clearRefactorRecoveryJournalV2,
  getRefactorRecoveryJournalV2,
  listRefactorRecoveryJournalsV2,
  prepareRefactorRecoveryJournalV2,
  recordRefactorRecoveryJournalV2,
  refactorApplyGate,
  refactorJournalPostImageMatches,
  resolveRecoveryDocTarget,
  updateRefactorRecoveryJournalV2,
  type RefactorPlanV4,
  type RefactorRecoveryDocumentSnapshotV2,
} from "../../refactorPlan";
import { dummyEvidence } from "./harness";

export function registerrefactorPlanHistory3Cases() {

  describe("ED-AUDIT-014: v2 refactor recovery journal", () => {
    const mockStorage = (failSetOnce?: Error) => {
      const store = new Map<string, string>();
      let failNextSet = failSetOnce != null;
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (failNextSet) {
            failNextSet = false;
            throw failSetOnce;
          }
          store.set(k, v);
        },
        removeItem: (k: string) => { store.delete(k); },
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
        clear: () => store.clear(),
      } as unknown as Storage;
    };

    const planFor = (edit: LspWorkspaceEdit): RefactorPlanV4 => buildRefactorPlan({
      actionId: "rename-v2",
      kind: "rename",
      evidence: dummyEvidence,
      edit,
      roots: [{ path: "/workspace" }],
      currentTexts: {
        "/workspace/A.java": "int alpha = 1;",
        "/workspace/B.java": "int beta = 2;",
      },
    });

    const textEdit: LspWorkspaceEdit = {
      documentEdits: [
        {
          uri: "file:///workspace/A.java",
          path: "/workspace/A.java",
          edits: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, newText: "nextAlpha" }],
        },
        {
          uri: "file:///workspace/B.java",
          path: "/workspace/B.java",
          edits: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } }, newText: "nextBeta" }],
        },
      ],
    };

    const preImages = [
      {
        uri: "file:///workspace/A.java",
        canonicalPath: "/workspace/A.java",
        preText: "int alpha = 1;",
        encoding: "UTF-8",
        bom: false,
        eol: "lf" as const,
      },
      {
        uri: "file:///workspace/B.java",
        canonicalPath: "/workspace/B.java",
        preText: "int beta = 2;",
        encoding: "UTF-16",
        bom: true,
        eol: "crlf" as const,
      },
    ];

    it("prepares a complete v2 entry with per-resource pre/post images and metadata", () => {
      const preparation = prepareRefactorRecoveryJournalV2({
        plan: planFor(textEdit),
        edit: textEdit,
        preImages,
        workspaceRoot: "/workspace",
        transactionId: "tx-wedit-test-1",
      });
      expect(preparation.state).toBe("prepared");
      if (preparation.state !== "prepared") return;
      const entry = preparation.entry;
      expect(entry.schemaVersion).toBe(2);
      expect(entry.status).toBe("prepared");
      expect(entry.transactionId).toBe("tx-wedit-test-1");
      expect(entry.workspaceRoot).toBe("/workspace");
      expect(entry.appliedOperationIndex).toBeNull();
      expect(entry.verification.checkedAt).toBeNull();
      expect(entry.documents).toHaveLength(2);
      expect(entry.documents[0].preHash).toBe(sha256Hex("int alpha = 1;"));
      expect(entry.documents[0].postText).toBe("int nextAlpha = 1;");
      expect(entry.documents[0].postHash).toBe(sha256Hex("int nextAlpha = 1;"));
      expect(entry.documents[0].encoding).toBe("UTF-8");
      expect(entry.documents[0].eol).toBe("lf");
      expect(entry.documents[1].encoding).toBe("UTF-16");
      expect(entry.documents[1].bom).toBe(true);
      expect(entry.documents[1].eol).toBe("crlf");
    });

    it("ED-FOLLOW-001: journals a pure file move with the moved bytes' content proof", () => {
      const resourceEdit: LspWorkspaceEdit = {
        documentEdits: [],
        operations: [{
          kind: "rename",
          oldUri: "file:///workspace/A.java",
          oldPath: "/workspace/A.java",
          newUri: "file:///workspace/A2.java",
          newPath: "/workspace/A2.java",
          overwrite: false,
          ignoreIfExists: false,
          annotationId: null,
        }],
      };
      const preparation = prepareRefactorRecoveryJournalV2({
        plan: planFor(resourceEdit),
        edit: resourceEdit,
        preImages: [],
        workspaceRoot: "/workspace",
        transactionId: "tx-wedit-test-2",
      });
      expect(preparation.state).toBe("prepared");
      if (preparation.state !== "prepared") return;
      expect(preparation.entry.documents).toHaveLength(0);
      expect(preparation.entry.resourceMoves).toHaveLength(1);
      expect(preparation.entry.resourceMoves[0]).toMatchObject({
        oldPath: "/workspace/A.java",
        newPath: "/workspace/A2.java",
      });
      // No text op rides the move: no content proof, reversal moves bytes only.
      expect(preparation.entry.resourceMoves[0].contentHash).toBeNull();
    });

    it("ED-FOLLOW-001: keeps an explicit unsupported boundary for create/delete", () => {
      for (const kind of ["create", "delete"] as const) {
        const resourceEdit: LspWorkspaceEdit = {
          documentEdits: [],
          operations: [kind === "create"
            ? {
              kind: "create" as const,
              uri: "file:///workspace/C.java",
              path: "/workspace/C.java",
              overwrite: false,
              ignoreIfExists: false,
              annotationId: null,
            }
            : {
              kind: "delete" as const,
              uri: "file:///workspace/A.java",
              path: "/workspace/A.java",
              recursive: false,
              ignoreIfNotExists: false,
              annotationId: null,
            }],
        };
        const preparation = prepareRefactorRecoveryJournalV2({
          plan: planFor(resourceEdit),
          edit: resourceEdit,
          preImages: [],
          workspaceRoot: "/workspace",
          transactionId: `tx-wedit-test-2${kind}`,
        });
        expect(preparation.state).toBe("unsupported");
        if (preparation.state !== "unsupported") continue;
        expect(preparation.reason).toContain("create/delete");
      }
    });

    it("ED-FOLLOW-001: pins the content proof from the matching text-op preimage on mixed edits", () => {
      const mixedEdit: LspWorkspaceEdit = {
        documentEdits: [{
          uri: "file:///workspace/A.java",
          path: "/workspace/A.java",
          edits: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, newText: "nextAlpha" }],
        }],
        operations: [
          {
            kind: "text",
            document: {
              uri: "file:///workspace/A.java",
              path: "/workspace/A.java",
              version: null,
              edits: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, newText: "nextAlpha" }],
            },
          },
          {
            kind: "rename",
            oldUri: "file:///workspace/A.java",
            oldPath: "/workspace/A.java",
            newUri: "file:///workspace/A2.java",
            newPath: "/workspace/A2.java",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          },
        ],
      };
      const preparation = prepareRefactorRecoveryJournalV2({
        plan: planFor(mixedEdit),
        edit: mixedEdit,
        preImages: [preImages[0]],
        workspaceRoot: "/workspace",
        transactionId: "tx-wedit-test-2mixed",
      });
      expect(preparation.state).toBe("prepared");
      if (preparation.state !== "prepared") return;
      expect(preparation.entry.documents).toHaveLength(1);
      expect(preparation.entry.resourceMoves).toHaveLength(1);
      expect(preparation.entry.resourceMoves[0].contentHash).toBe(sha256Hex("int alpha = 1;"));
    });

    it("ED-FOLLOW-001: resolves journal document targets through moves by live existence", () => {
      const moves = [{
        oldUri: "file:///workspace/A.java",
        newUri: "file:///workspace/A2.java",
        oldPath: "/workspace/A.java",
        newPath: "/workspace/A2.java",
        contentHash: null,
      }];
      const doc = { uri: "file:///workspace/A.java", canonicalPath: "/workspace/A.java" };
      expect(resolveRecoveryDocTarget(doc, moves, () => false)).toBe("/workspace/A2.java");
      expect(resolveRecoveryDocTarget(doc, moves, () => true)).toBe("/workspace/A.java");
      const direct = { uri: "file:///workspace/A2.java", canonicalPath: "/workspace/A2.java" };
      expect(resolveRecoveryDocTarget(direct, moves, () => false)).toBe("/workspace/A2.java");
      const foreign = { uri: "file:///workspace/B.java", canonicalPath: "/workspace/B.java" };
      expect(resolveRecoveryDocTarget(foreign, moves, () => false)).toBe("/workspace/B.java");
    });

    it("reports incomplete when a text target has no captured preimage", () => {
      const preparation = prepareRefactorRecoveryJournalV2({
        plan: planFor(textEdit),
        edit: textEdit,
        preImages: [preImages[0]],
        workspaceRoot: "/workspace",
        transactionId: "tx-wedit-test-3",
      });
      expect(preparation.state).toBe("incomplete");
      if (preparation.state !== "incomplete") return;
      expect(preparation.reason).toContain("B.java");
    });

    it("persists with a typed result and surfaces storage failures instead of swallowing them", () => {
      const storage = mockStorage();
      const preparation = prepareRefactorRecoveryJournalV2({
        plan: planFor(textEdit),
        edit: textEdit,
        preImages,
        workspaceRoot: "/workspace",
        transactionId: "tx-wedit-test-4",
      });
      if (preparation.state !== "prepared") throw new Error("expected prepared");
      expect(recordRefactorRecoveryJournalV2(preparation.entry, storage)).toEqual({ ok: true });
      expect(getRefactorRecoveryJournalV2(preparation.entry.recoveryId, storage)?.transactionId).toBe("tx-wedit-test-4");

      const failing = mockStorage(new Error("quota exceeded"));
      const failed = recordRefactorRecoveryJournalV2(preparation.entry, failing);
      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("expected failure");
      expect(failed.reason).toContain("quota exceeded");
    });

    it("lists v2 entries, counts v1 as legacy, and never parses v1 as v2", () => {
      const storage = mockStorage();
      const preparation = prepareRefactorRecoveryJournalV2({
        plan: planFor(textEdit),
        edit: textEdit,
        preImages,
        workspaceRoot: "/workspace",
        transactionId: "tx-wedit-test-5",
      });
      if (preparation.state !== "prepared") throw new Error("expected prepared");
      recordRefactorRecoveryJournalV2(preparation.entry, storage);
      // A v1 entry under the legacy prefix.
      storage.setItem("taomni.refactor.recovery.v1:legacy-1", JSON.stringify({ recoveryId: "legacy-1", status: "committed" }));
      // Corrupt record under the v2 prefix.
      storage.setItem("taomni.refactor.recovery.v2:broken", "{not json");

      const listing = listRefactorRecoveryJournalsV2("/workspace", storage);
      expect(listing.entries).toHaveLength(1);
      expect(listing.entries[0].recoveryId).toBe(preparation.entry.recoveryId);
      expect(listing.legacyCount).toBe(1);
      expect(listing.invalidCount).toBe(1);

      // v1 data is never returned by the v2 getter.
      expect(getRefactorRecoveryJournalV2("legacy-1", storage)).toBeNull();
      // Workspace filter excludes foreign roots.
      expect(listRefactorRecoveryJournalsV2("/other", storage).entries).toHaveLength(0);
    });

    it("patches status with a typed result and fails when the entry is missing", () => {
      const storage = mockStorage();
      const preparation = prepareRefactorRecoveryJournalV2({
        plan: planFor(textEdit),
        edit: textEdit,
        preImages,
        workspaceRoot: "/workspace",
        transactionId: "tx-wedit-test-6",
      });
      if (preparation.state !== "prepared") throw new Error("expected prepared");
      recordRefactorRecoveryJournalV2(preparation.entry, storage);
      const updated = updateRefactorRecoveryJournalV2(preparation.entry.recoveryId, (entry) => ({
        ...entry,
        status: "recovery-required",
        appliedOperationIndex: 1,
        verification: { mismatchedUris: ["file:///workspace/B.java"], checkedAt: 123 },
      }), storage);
      expect(updated).toEqual({ ok: true });
      const reread = getRefactorRecoveryJournalV2(preparation.entry.recoveryId, storage);
      expect(reread?.status).toBe("recovery-required");
      expect(reread?.appliedOperationIndex).toBe(1);
      expect(reread?.verification.mismatchedUris).toEqual(["file:///workspace/B.java"]);

      expect(updateRefactorRecoveryJournalV2("missing-id", (entry) => entry, storage).ok).toBe(false);
      expect(clearRefactorRecoveryJournalV2(preparation.entry.recoveryId, storage)).toEqual({ ok: true });
      expect(getRefactorRecoveryJournalV2(preparation.entry.recoveryId, storage)).toBeNull();
    });

    it("matches post-images raw and EOL-normalized, but rejects foreign content", () => {
      const crlfDoc: RefactorRecoveryDocumentSnapshotV2 = {
        uri: "file:///workspace/B.java",
        canonicalPath: "/workspace/B.java",
        preText: "int beta = 2;",
        preHash: sha256Hex("int beta = 2;"),
        postText: "int nextBeta = 2;\nint gamma = 3;",
        postHash: sha256Hex("int nextBeta = 2;\nint gamma = 3;"),
        encoding: "UTF-8",
        bom: false,
        eol: "crlf",
      };
      expect(refactorJournalPostImageMatches(crlfDoc, "int nextBeta = 2;\nint gamma = 3;")).toBe(true);
      expect(refactorJournalPostImageMatches(crlfDoc, "int nextBeta = 2;\r\nint gamma = 3;")).toBe(true);
      expect(refactorJournalPostImageMatches(crlfDoc, "third-party edit")).toBe(false);
      const lfDoc: RefactorRecoveryDocumentSnapshotV2 = { ...crlfDoc, eol: "lf" };
      expect(refactorJournalPostImageMatches(lfDoc, "int nextBeta = 2;\nint gamma = 3;")).toBe(true);
      expect(refactorJournalPostImageMatches(lfDoc, "int nextBeta = 2;\r\nint gamma = 3;")).toBe(false);
    });
  });

  describe("ED-PROJECT-005: refactor plan facts generation pinning", () => {
    const factsPinnedPlan = (projectFacts: RefactorPlanV4["projectFacts"]): RefactorPlanV4 => ({
      actionId: "rename-facts",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: { value: "complete", source: "provider-asserted", proof: "p" },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
      projectFacts,
    });

    it("records the explicit facts snapshot on the plan (A1)", () => {
      const plan = buildRefactorPlan({
        actionId: "rename-explicit",
        kind: "rename",
        evidence: dummyEvidence,
        edit: {
          documentEdits: [
            {
              uri: "file:///workspace/src/A.java",
              path: "/workspace/src/A.java",
              edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "A2" }],
            },
          ],
        },
        roots: [{ path: "/workspace" }],
        projectFacts: { workspaceRoot: "/workspace", generation: 7, fingerprint: "fp-7" },
      });

      expect(plan.projectFacts).toEqual({ workspaceRoot: "/workspace", generation: 7, fingerprint: "fp-7" });
    });

    it("resolves the live ready snapshot when the input omits it (A1)", async () => {
      const { useProjectFactsStore } = await import("../../../../../stores/projectFactsStore");
      useProjectFactsStore.setState({ workspaces: {} });
      useProjectFactsStore.setState({
        workspaces: {
          "/workspace": {
            workspaceRoot: "/workspace",
            generation: 4,
            status: "ready",
            reason: null,
            fingerprint: "fp-4",
            structure: { modules: [] } as unknown as ProjectStructureSnapshotV2,
            provenance: null,
            isStale: false,
            abortController: null,
          },
        },
      });

      const plan = buildRefactorPlan({
        actionId: "rename-live",
        kind: "rename",
        evidence: dummyEvidence,
        edit: {
          documentEdits: [
            {
              uri: "file:///workspace/src/A.java",
              path: "/workspace/src/A.java",
              edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "A2" }],
            },
          ],
        },
        roots: [{ path: "/workspace" }],
      });

      expect(plan.projectFacts).toEqual({ workspaceRoot: "/workspace", generation: 4, fingerprint: "fp-4" });
      useProjectFactsStore.setState({ workspaces: {} });
    });

    it("blocks apply when the pinned generation went stale (A2)", async () => {
      const { useProjectFactsStore } = await import("../../../../../stores/projectFactsStore");
      useProjectFactsStore.setState({
        workspaces: {
          "/workspace": {
            workspaceRoot: "/workspace",
            generation: 5,
            status: "ready",
            reason: null,
            fingerprint: "fp-5",
            structure: { modules: [] } as unknown as ProjectStructureSnapshotV2,
            provenance: null,
            isStale: false,
            abortController: null,
          },
        },
      });

      const gate = refactorApplyGate(
        factsPinnedPlan({ workspaceRoot: "/workspace", generation: 4, fingerprint: "fp-4" }),
      );
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toContain("G4 -> G5");
      useProjectFactsStore.setState({ workspaces: {} });
    });

    it("allows apply when the pinned generation is current and when unpinned (A2)", async () => {
      const { useProjectFactsStore } = await import("../../../../../stores/projectFactsStore");
      useProjectFactsStore.setState({
        workspaces: {
          "/workspace": {
            workspaceRoot: "/workspace",
            generation: 4,
            status: "ready",
            reason: null,
            fingerprint: "fp-4",
            structure: { modules: [] } as unknown as ProjectStructureSnapshotV2,
            provenance: null,
            isStale: false,
            abortController: null,
          },
        },
      });

      const current = refactorApplyGate(
        factsPinnedPlan({ workspaceRoot: "/workspace", generation: 4, fingerprint: "fp-4" }),
      );
      expect(current.allowed).toBe(true);

      const unpinned = refactorApplyGate(factsPinnedPlan(null));
      expect(unpinned.allowed).toBe(true);
      useProjectFactsStore.setState({ workspaces: {} });
    });
  });
}
