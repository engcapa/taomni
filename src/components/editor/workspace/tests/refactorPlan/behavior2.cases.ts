import { describe, expect, it } from "vitest";
import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { sha256Hex } from "../../projectAnalysisModel";
import {
  buildRefactorPlan,
  buildRefactorRecoveryJournalEntry,
  clearRefactorRecoveryJournal,
  evaluateDestructiveRefactorAvailability,
  getRefactorRecoveryJournal,
  listRefactorRecoveryJournals,
  recordRefactorRecoveryJournal,
  refactorApplyGate,
  verifyExclusionSafety,
  verifyRefactorPostHashes,
} from "../../refactorPlan";
import { dummyEvidence } from "./harness";

export function registerrefactorPlanBehavior2Cases() {

  describe("buildRefactorPlan & verifyExclusionSafety §8.20.6 & §8.21.2", () => {
    const sampleEdit: LspWorkspaceEdit = {
      documentEdits: [
        {
          uri: "file:///workspace/src/A.java",
          path: "/workspace/src/A.java",
          edits: [
            { range: { start: { line: 10, character: 4 }, end: { line: 10, character: 12 } }, newText: "nextName" },
          ],
        },
        {
          uri: "file:///workspace/src/B.java",
          path: "/workspace/src/B.java",
          edits: [
            { range: { start: { line: 20, character: 4 }, end: { line: 20, character: 12 } }, newText: "nextName" },
          ],
        },
      ],
    };

    it("builds a plan with classified affected URIs and excludable groups", () => {
      const plan = buildRefactorPlan({
        actionId: "plan-1",
        kind: "rename",
        evidence: dummyEvidence,
        edit: sampleEdit,
        roots: [{ path: "/workspace" }],
        requiredOperationIndexes: [0], // first edit is declaration, required
      });

      expect(plan.operations).toHaveLength(2);
      expect(plan.affectedUris).toHaveLength(2);
      expect(plan.affectedUris[0].owner).toBe("workspace");
      expect(plan.affectedUris[1].owner).toBe("workspace");
      expect(plan.documents).toHaveLength(2);
      expect(plan.excludableGroups).toHaveLength(2);
      expect(plan.excludableGroups[0].required).toBe(true);
      expect(plan.excludableGroups[1].required).toBe(false);
    });

    it("maps document revisions and hashes per URI instead of using first open file", () => {
      const multiFileEdit: LspWorkspaceEdit = {
        documentEdits: [
          {
            uri: "file:///workspace/src/A.java",
            path: "/workspace/src/A.java",
            edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "A2" }],
          },
          {
            uri: "file:///workspace/src/B.java",
            path: "/workspace/src/B.java",
            edits: [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, newText: "B2" }],
          },
        ],
      };

      const plan = buildRefactorPlan({
        actionId: "plan-revisions",
        kind: "rename",
        evidence: dummyEvidence,
        edit: multiFileEdit,
        roots: [{ path: "/workspace" }],
        openFiles: {
          "file:///workspace/src/A.java": { documentRevision: 10, diskHash: "hash-a" },
          "file:///workspace/src/B.java": { documentRevision: 20, diskHash: "hash-b" },
        },
      });

      expect(plan.documents).toHaveLength(2);
      const docA = plan.documents.find((d) => d.uri === "file:///workspace/src/A.java");
      const docB = plan.documents.find((d) => d.uri === "file:///workspace/src/B.java");
      expect(docA?.expectedDocumentRevision).toBe(10);
      expect(docA?.expectedDiskHash).toBe("hash-a");
      expect(docB?.expectedDocumentRevision).toBe(20);
      expect(docB?.expectedDiskHash).toBe("hash-b");
    });

    it("flags library file modification as conflict in buildRefactorPlan", () => {
      const externalEdit: LspWorkspaceEdit = {
        documentEdits: [
          {
            uri: "file:///usr/lib/java/rt.jar",
            path: "/usr/lib/java/rt.jar",
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" }],
          },
        ],
      };
      const plan = buildRefactorPlan({
        actionId: "plan-2",
        kind: "rename",
        evidence: dummyEvidence,
        edit: externalEdit,
        roots: [{ path: "/workspace" }],
      });

      expect(plan.affectedUris[0].owner).not.toBe("workspace");
      const decision = refactorApplyGate(plan);
      expect(decision.allowed).toBe(false);
    });

    it("verifyExclusionSafety prevents excluding required operation groups", () => {
      const plan = buildRefactorPlan({
        actionId: "plan-3",
        kind: "rename",
        evidence: dummyEvidence,
        edit: sampleEdit,
        roots: [{ path: "/workspace" }],
        requiredOperationIndexes: [0],
      });

      const safeExclusion = verifyExclusionSafety(plan, new Set([1]));
      expect(safeExclusion.safe).toBe(true);

      const unsafeExclusion = verifyExclusionSafety(plan, new Set([0]));
      expect(unsafeExclusion.safe).toBe(false);
      expect(unsafeExclusion.reason).toContain("cannot be excluded");
    });

    describe("§8.22.2 U1 evaluateDestructiveRefactorAvailability", () => {
      it("returns disabled when no attestation is provided", () => {
        const avail = evaluateDestructiveRefactorAvailability(null);
        expect(avail.state).toBe("disabled");
        if (avail.state === "disabled") {
          expect(avail.reasonCode).toBe("provider-no-safe-delete-attestation");
          expect(avail.message).toContain("does not attest complete Safe Delete coverage");
        }
      });

      it("returns disabled when attestation coverage is partial or missing proof id", () => {
        const partialAvail = evaluateDestructiveRefactorAvailability({
          providerId: "jdtls",
          providerVersion: "1.61.0",
          projectFingerprint: "fp",
          capability: "safe-delete",
          coverage: "provider-partial" as any,
          supportedSymbolKinds: ["class"],
          proof: { kind: "provider-command", id: "cmd" },
        });
        expect(partialAvail.state).toBe("disabled");

        const noProofAvail = evaluateDestructiveRefactorAvailability({
          providerId: "jdtls",
          providerVersion: "1.61.0",
          projectFingerprint: "fp",
          capability: "safe-delete",
          coverage: "provider-complete",
          supportedSymbolKinds: ["class"],
          proof: { kind: "provider-command", id: "" },
        });
        expect(noProofAvail.state).toBe("disabled");
      });

      it("returns enabled when provider provides complete attestation with proof", () => {
        const avail = evaluateDestructiveRefactorAvailability({
          providerId: "jdtls",
          providerVersion: "1.61.0",
          projectFingerprint: "fp",
          capability: "safe-delete",
          coverage: "provider-complete",
          supportedSymbolKinds: ["class", "method"],
          proof: { kind: "provider-command", id: "java.action.safeDelete" },
        });
        expect(avail.state).toBe("enabled");
        if (avail.state === "enabled") {
          expect(avail.attestation.proof.id).toBe("java.action.safeDelete");
        }
      });
    });

    describe("ED-REF-001: Multi-file rename, dirty conflicts, and library guards", () => {
      it("ED-FOLLOW-003: file-key-shaped openFiles never match, so guards stay silent rather than misattribute", () => {
        // Regression pin for the production bug where the shell passed its
        // key-keyed openFiles map (`root:<id>:<path>`) straight through: no
        // entry ever matched, so the dirty guard was dead for rename. The
        // shell must pass a path-keyed view (buildPlanOpenFiles); a key-keyed
        // map must not phantom-match some other file's state.
        const plan = buildRefactorPlan({
          actionId: "rename-no-phantom",
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
          openFiles: {
            "root:ws:/workspace/A.java": { revision: 1, documentRevision: 2, dirty: true },
          },
        });
        expect(plan.conflicts).toHaveLength(0);
      });
      it("builds multi-file rename plan and blocks on dirty buffer conflict", () => {
        const multiFileEdit: LspWorkspaceEdit = {
          documentEdits: [
            {
              uri: "file:///workspace/core/User.java",
              path: "/workspace/core/User.java",
              version: 1,
              edits: [{ range: { start: { line: 5, character: 13 }, end: { line: 5, character: 17 } }, newText: "Account" }],
            },
            {
              uri: "file:///workspace/app/UserService.java",
              path: "/workspace/app/UserService.java",
              version: 2,
              edits: [{ range: { start: { line: 12, character: 8 }, end: { line: 12, character: 12 } }, newText: "Account" }],
            },
          ],
        };

        const plan = buildRefactorPlan({
          actionId: "rename-user-account",
          kind: "rename",
          evidence: dummyEvidence,
          edit: multiFileEdit,
          roots: [{ path: "/workspace" }],
          openFiles: {
            "/workspace/core/User.java": { revision: 1, documentRevision: 1, diskHash: "hash-user" },
            "/workspace/app/UserService.java": { revision: 2, documentRevision: 3, diskHash: "hash-service" }, // Revision mismatch (dirty)
          },
          conflicts: [
            {
              severity: "error",
              message: "File '/workspace/app/UserService.java' has unsaved buffer edits",
              location: null,
              // The dirty-buffer conflict is observed by the client from local buffer
              // revisions, which is what client-observed-bounded denotes. "derived" was
              // never a member of the closed provenance union.
              source: "client-observed-bounded",
            },
          ],
        });

        const gate = refactorApplyGate(plan);
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toContain("unsaved buffer edits");
        expect(gate.blockingConflicts).toHaveLength(1);
      });

      it("hard blocks when refactoring touches read-only jar library", () => {
        const libraryEdit: LspWorkspaceEdit = {
          documentEdits: [
            {
              // A jar: library buffer has no workspace file, so path stays null.
              uri: "jar:file:///root/.m2/repository/com/google/guava/guava.jar!/ImmutableList.class",
              path: null,
              version: null,
              edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, newText: "List" }],
            },
          ],
        };

        const plan = buildRefactorPlan({
          actionId: "rename-library",
          kind: "rename",
          evidence: dummyEvidence,
          edit: libraryEdit,
          roots: [{ path: "/workspace" }],
        });

        const gate = refactorApplyGate(plan);
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toContain("read-only library resource");
      });

      it("automatically detects dirty open buffer without manual conflict passing (ED-REF-001-A2)", () => {
        const edit: LspWorkspaceEdit = {
          documentEdits: [
            {
              uri: "file:///workspace/src/DirtyFile.java",
              path: "/workspace/src/DirtyFile.java",
              edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: "Test" }],
            },
          ],
        };

        const plan = buildRefactorPlan({
          actionId: "rename-dirty",
          kind: "rename",
          evidence: dummyEvidence,
          edit,
          roots: [{ path: "/workspace" }],
          openFiles: {
            "/workspace/src/DirtyFile.java": {
              dirty: true,
              revision: 1,
              documentRevision: 1,
            },
          },
        });

        const gate = refactorApplyGate(plan);
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toContain("unsaved buffer edits");
        expect(plan.conflicts[0].source).toBe("client-observed-bounded");
      });

      it("automatically blocks read-only file and external resources (ED-REF-001-A2)", () => {
        const edit: LspWorkspaceEdit = {
          documentEdits: [
            {
              uri: "file:///workspace/src/ReadOnly.java",
              path: "/workspace/src/ReadOnly.java",
              edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: "Test" }],
            },
          ],
        };

        const readOnlyPlan = buildRefactorPlan({
          actionId: "rename-readonly",
          kind: "rename",
          evidence: dummyEvidence,
          edit,
          roots: [{ path: "/workspace" }],
          openFiles: {
            "/workspace/src/ReadOnly.java": {
              readOnly: true,
            },
          },
        });

        const readOnlyGate = refactorApplyGate(readOnlyPlan);
        expect(readOnlyGate.allowed).toBe(false);
        expect(readOnlyGate.reason).toContain("Cannot modify read-only file");

        const externalEdit: LspWorkspaceEdit = {
          documentEdits: [
            {
              uri: "file:///etc/hosts",
              path: "/etc/hosts",
              edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: "Test" }],
            },
          ],
        };

        const externalPlan = buildRefactorPlan({
          actionId: "rename-external",
          kind: "rename",
          evidence: dummyEvidence,
          edit: externalEdit,
          roots: [{ path: "/workspace" }],
        });

        const externalGate = refactorApplyGate(externalPlan);
        expect(externalGate.allowed).toBe(false);
        expect(externalGate.reason).toContain("Cannot modify read-only external resource");
      });

      it("computes and verifies post-hashes for multi-file refactoring (ED-REF-001-A3)", () => {
        const fileAText = "package com.example;\npublic class App {\n    void oldMethod() {}\n}\n";
        const fileBText = "package com.example;\npublic class Client {\n    void call() { new App().oldMethod(); }\n}\n";

        const multiEdit: LspWorkspaceEdit = {
          documentEdits: [
            {
              uri: "file:///workspace/App.java",
              path: "/workspace/App.java",
              edits: [{ range: { start: { line: 2, character: 9 }, end: { line: 2, character: 18 } }, newText: "newMethod" }],
            },
            {
              uri: "file:///workspace/Client.java",
              path: "/workspace/Client.java",
              edits: [{ range: { start: { line: 2, character: 28 }, end: { line: 2, character: 37 } }, newText: "newMethod" }],
            },
          ],
        };

        const plan = buildRefactorPlan({
          actionId: "rename-hashes",
          kind: "rename",
          evidence: dummyEvidence,
          edit: multiEdit,
          roots: [{ path: "/workspace" }],
          currentTexts: {
            "/workspace/App.java": fileAText,
            "/workspace/Client.java": fileBText,
          },
        });

        expect(plan.documents).toHaveLength(2);
        expect(plan.documents[0].preTextSha256).toBe(sha256Hex(fileAText));
        expect(plan.documents[1].preTextSha256).toBe(sha256Hex(fileBText));
        expect(plan.documents[0].expectedPostHash).not.toBeNull();
        expect(plan.documents[1].expectedPostHash).not.toBeNull();

        const expectedPostA = "package com.example;\npublic class App {\n    void newMethod() {}\n}\n";
        const expectedPostB = "package com.example;\npublic class Client {\n    void call() { new App().newMethod(); }\n}\n";
        expect(plan.documents[0].expectedPostHash).toBe(sha256Hex(expectedPostA));
        expect(plan.documents[1].expectedPostHash).toBe(sha256Hex(expectedPostB));

        // 1. Post-hash verification with correct text matches
        const passResult = verifyRefactorPostHashes(plan, {
          "/workspace/App.java": expectedPostA,
          "/workspace/Client.java": expectedPostB,
        });
        expect(passResult.allMatched).toBe(true);
        expect(passResult.mismatches).toHaveLength(0);
        expect(passResult.verifiedDocuments).toBe(2);

        // 2. Post-hash verification detects mismatch
        const failResult = verifyRefactorPostHashes(plan, {
          "/workspace/App.java": expectedPostA,
          "/workspace/Client.java": "corrupted text",
        });
        expect(failResult.allMatched).toBe(false);
        expect(failResult.mismatches).toHaveLength(1);
        expect(failResult.mismatches[0].uri).toBe("file:///workspace/Client.java");
      });

      it("records v1 pre-images and hashes for storage roundtrip; replay is intentionally removed (ED-REF-001-A4, ED-AUDIT-014)", () => {
        const fileAText = "int alpha = 1;";
        const fileBText = "int beta = 2;";

        const edit: LspWorkspaceEdit = {
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

        const plan = buildRefactorPlan({
          actionId: "rename-recovery",
          kind: "rename",
          evidence: dummyEvidence,
          edit,
          roots: [{ path: "/workspace" }],
          currentTexts: {
            "/workspace/A.java": fileAText,
            "/workspace/B.java": fileBText,
          },
        });

        // Build recovery journal entry
        const journalEntry = buildRefactorRecoveryJournalEntry(
          plan,
          {
            "/workspace/A.java": fileAText,
            "/workspace/B.java": fileBText,
          },
          "/workspace",
        );
        expect(journalEntry).not.toBeNull();
        expect(journalEntry?.documents).toHaveLength(2);
        expect(journalEntry?.documents[0].preHash).toBe(sha256Hex(fileAText));
        expect(journalEntry?.documents[1].preHash).toBe(sha256Hex(fileBText));

        // Storage persistence & retrieval
        const mockStorage = (() => {
          const store = new Map<string, string>();
          return {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => { store.set(k, v); },
            removeItem: (k: string) => { store.delete(k); },
            key: (i: number) => Array.from(store.keys())[i] ?? null,
            get length() { return store.size; },
            clear: () => store.clear(),
          } as unknown as Storage;
        })();

        recordRefactorRecoveryJournal(journalEntry!, mockStorage);
        const retrieved = getRefactorRecoveryJournal(journalEntry!.recoveryId, mockStorage);
        expect(retrieved?.actionId).toBe("rename-recovery");
        expect(retrieved?.documents).toHaveLength(2);

        const allJournals = listRefactorRecoveryJournals("/workspace", mockStorage);
        expect(allJournals).toHaveLength(1);

        // Clean journal
        clearRefactorRecoveryJournal(journalEntry!.recoveryId, mockStorage);
        expect(getRefactorRecoveryJournal(journalEntry!.recoveryId, mockStorage)).toBeNull();
      });
    });
  });
}
