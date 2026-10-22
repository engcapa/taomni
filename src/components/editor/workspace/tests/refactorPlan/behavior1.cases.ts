import { describe, expect, it } from "vitest";
import { refactorApplyGate, type RefactorPlanV4 } from "../../refactorPlan";
import { dummyEvidence, dummyLocation } from "./harness";

export function registerrefactorPlanBehavior1Cases() {

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
}
