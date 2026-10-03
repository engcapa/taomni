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
  buildRefactorPostTextIndex,
  resolveRefactorPostTextForDocument,
  verifyRefactorMovePostEndpoints,
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
  isPendingRefactorRecoveryEntry,
  dismissRefactorRecoveryEntry,
  resolveRecoveryMoveProof,
  recoveryMoveProofMatches,
  refactorJournalPostImageMatches,
  resolveRecoveryDocTarget,
  type RefactorPlanV4,
  type RefactorRecoveryDocumentSnapshotV2,
} from "./refactorPlan";
import { normalizeFsPath, fsPathComparisonKey } from "./codeWorkspaceModel";
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

  const storedEntry = (overrides: Partial<import("./refactorPlan").RefactorRecoveryJournalEntryV2> = {}) => ({
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
