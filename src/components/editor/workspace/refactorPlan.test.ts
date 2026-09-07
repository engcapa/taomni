import { describe, expect, it } from "vitest";
import type { LspLocation, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import { buildCapabilityEvidence } from "./capabilityEvidence";
import type { ProjectStructureSnapshotV2 } from "./projectStructureModel";
import {
  buildRefactorPlan,
  refactorApplyGate,
  verifyExclusionSafety,
  evaluateDestructiveRefactorAvailability,
  verifyRefactorPostHashes,
  buildRefactorRecoveryJournalEntry,
  recordRefactorRecoveryJournal,
  getRefactorRecoveryJournal,
  listRefactorRecoveryJournals,
  clearRefactorRecoveryJournal,
  prepareRefactorRecoveryJournalV2,
  recordRefactorRecoveryJournalV2,
  getRefactorRecoveryJournalV2,
  listRefactorRecoveryJournalsV2,
  updateRefactorRecoveryJournalV2,
  clearRefactorRecoveryJournalV2,
  refactorJournalPostImageMatches,
  type RefactorPlanV4,
  type RefactorRecoveryDocumentSnapshotV2,
} from "./refactorPlan";
import { sha256Hex } from "./projectAnalysisModel";

const dummyLocation: LspLocation = {
  uri: "file:///workspace/src/A.java",
  path: "/workspace/src/A.java",
  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } },
};

const dummyEvidence = buildCapabilityEvidence({
  capabilityId: "refactor.rename",
  languageId: "java",
  provider: { id: "jdtls", version: "1.61.0", generation: 1 },
  projectFingerprint: "fingerprint-123",
  uri: "file:///workspace/src/A.java",
  revision: 1,
  scope: "project",
  complete: false,
});

describe("refactorApplyGate §8.20.6 & §8.21.2 V1", () => {
  it("blocks outright when error-severity conflicts exist", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-1",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: { value: "complete", source: "provider-asserted", proof: null },
      conflicts: [
        { severity: "error", message: "Naming collision with existing class 'B'", location: dummyLocation, source: "reported" },
      ],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.requiresConfirm).toBe(false);
    expect(decision.reason).toContain("Naming collision");
    expect(decision.blockingConflicts).toHaveLength(1);
  });

  it("requires explicit user confirmation when only warning conflicts exist", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-2",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: { value: "complete", source: "provider-asserted", proof: null },
      conflicts: [
        { severity: "warning", message: "Overload might become ambiguous", location: dummyLocation, source: "reported" },
      ],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirm).toBe(true);
    expect(decision.reason).toContain("ambiguous");
    expect(decision.warningConflicts).toHaveLength(1);
  });

  it("hard blocks Safe Delete when completeness is provider-partial", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-3",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: { value: "partial", source: "protocol-bounded", proof: null },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Language provider does not attest complete Safe Delete coverage");
  });

  it("hard blocks Safe Delete when completeness is unknown", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-4",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: { value: "unknown", source: "unknown", proof: null },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Language provider does not attest complete Safe Delete coverage");
  });

  it("hard blocks Safe Delete when completeness is only client-observed bounded", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-5b",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: {
        value: "complete",
        source: "client-observed-bounded",
        proof: "all references resolved within workspace roots",
      },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Language provider does not attest complete Safe Delete coverage");
  });

  it("allows Safe Delete only when completeness is provider-asserted complete with proof", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-5",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: {
        value: "complete",
        source: "provider-asserted",
        proof: "jdtls dedicated safe delete command verified",
      },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirm).toBe(false);
  });

  it("hard blocks when any affected URI belongs to a read-only library or external source", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-6",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: { value: "complete", source: "provider-asserted", proof: null },
      conflicts: [],
      operations: [],
      documents: [
        { uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" },
        { uri: "jar:file:///root/.m2/repository/dep.jar!/Dep.class", canonicalPath: null, expectedDocumentRevision: null, expectedDiskHash: null, owner: "library" },
      ],
      requiredOperationIndexes: [],
      affectedUris: [
        { uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" },
        { uri: "jar:file:///root/.m2/repository/dep.jar!/Dep.class", revision: null, owner: "library" },
      ],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Cannot modify read-only library resource");
  });

  it("requires preview when completeness is partial", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-7",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: { value: "partial", source: "protocol-bounded", proof: null },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresPreview).toBe(true);
  });
});

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

  it("keeps an explicit unsupported boundary for resource operations", () => {
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
    expect(preparation.state).toBe("unsupported");
    if (preparation.state !== "unsupported") return;
    expect(preparation.reason).toContain("text-only");
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
    const { useProjectFactsStore } = await import("../../../stores/projectFactsStore");
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
    const { useProjectFactsStore } = await import("../../../stores/projectFactsStore");
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
    const { useProjectFactsStore } = await import("../../../stores/projectFactsStore");
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
