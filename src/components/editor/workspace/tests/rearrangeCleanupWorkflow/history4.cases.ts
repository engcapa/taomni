import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../projectAnalysisModel";
import { executeCleanupTransaction, executeRearrangeTransaction, type CleanupExecuteDeps, type RearrangeExecuteDeps } from "../../rearrangeCleanupWorkflow";

export function registerrearrangeCleanupWorkflowHistory4Cases() {

  // ---------------------------------------------------------------------------
  // ED-IMPROVE-002: execution status and effect facts stay separate; success
  // history/recovery identity is produced by the canonical apply boundary.
  // ---------------------------------------------------------------------------
  describe("ED-IMPROVE-002: effect/history/recovery result contract (model boundary)", () => {
    const PRE = "package com.example;\n\npublic class Service {\n    void beta() {}\n    void alpha() {}\n}\n";
    const POST = "package com.example;\n\npublic class Service {\n    void alpha() {}\n    void beta() {}\n}\n";
    const EDITS = [
      {
        range: { start: { line: 3, character: 0 }, end: { line: 4, character: 19 } },
        newText: "    void alpha() {}\n    void beta() {}",
      },
    ];

    function live(text: string) {
      return { text, revision: 7, readOnly: false, dirty: false };
    }

    function rearrangeDeps(overrides: Partial<RearrangeExecuteDeps> = {}): RearrangeExecuteDeps {
      return {
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [{ kind: "source.sortMembers", title: "Sort Members", raw: { id: 1 } }],
        })),
        resolveAction: vi.fn(async () => ({ state: "resolved" as const, edits: [...EDITS] })),
        readLive: vi.fn(() => live(PRE)),
        providerGeneration: vi.fn(() => 3),
        confirmPreview: vi.fn(async () => true),
        applyEdit: vi.fn(async () => ({ state: "applied" as const, postText: POST, historyId: "h-1" })),
        ...overrides,
      };
    }

    function cleanupDeps(overrides: Partial<CleanupExecuteDeps> = {}): CleanupExecuteDeps {
      return {
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [{ kind: "source.cleanup", title: "Clean up", raw: { id: 1 } }],
        })),
        resolveAction: vi.fn(async () => ({ state: "resolved" as const, edits: [...EDITS] })),
        readLive: vi.fn(() => live(PRE)),
        providerGeneration: vi.fn(() => 3),
        confirmPreview: vi.fn(async () => true),
        applyEdit: vi.fn(async () => ({ state: "applied" as const, postText: POST, historyId: "h-1" })),
        ...overrides,
      };
    }

    function rearrangeInput() {
      return {
        scope: "file" as const,
        targetPath: "src/Service.java",
        targetUri: "file:///repo/src/Service.java",
        readOnly: false,
        hasSelection: false,
        capabilities: { rearrangeSupported: true, providerId: "test-arrange", providerVersion: "0" },
      };
    }

    function cleanupInput() {
      return {
        scope: "file" as const,
        targetPath: "src/Service.java",
        targetUri: "file:///repo/src/Service.java",
        readOnly: false,
        capabilities: { cleanupSupported: true, providerId: "test-cleanup", providerVersion: "0" },
      };
    }

    it("reports the canonical success history id on the verified path", async () => {
      const deps = rearrangeDeps();
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toEqual({ ok: true, postHash: sha256Hex(POST), operationCount: 1, historyId: "h-1" });
    });

    it("passes the frozen postcondition facts into the canonical apply boundary", async () => {
      const contexts: unknown[] = [];
      const deps = rearrangeDeps({
        applyEdit: vi.fn(async (_edit, _guard, context) => {
          contexts.push(context);
          return { state: "applied" as const, postText: POST, historyId: "h-2" };
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: true, historyId: "h-2" });
      expect(contexts).toEqual([{
        targetPath: "src/Service.java",
        targetUri: "file:///repo/src/Service.java",
        preText: PRE,
        expectedPostHash: sha256Hex(POST),
      }]);
    });

    it("propagates a recovery-required apply with performed effect and no committed success", async () => {
      const deps = rearrangeDeps({
        applyEdit: vi.fn(async () => ({
          state: "recovery-required" as const,
          reason: "postcondition mismatch on src/Service.java",
          recoveryId: "rec-9",
          affectedPaths: ["src/Service.java"],
        })),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toEqual({
        ok: false,
        state: "recovery-required",
        reason: "postcondition mismatch on src/Service.java",
        effect: { kind: "performed", paths: ["src/Service.java"], recoveryId: "rec-9" },
        committed: false,
      });
    });

    it("propagates an unknown write acknowledgement as unknown effect", async () => {
      const deps = rearrangeDeps({
        applyEdit: vi.fn(async () => ({
          state: "unknown-effect" as const,
          reason: "result unknown — resolve the file in the recovery center",
          recoveryId: "tx-unknown",
          affectedPaths: ["src/Service.java"],
        })),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({
        ok: false,
        state: "unknown-effect",
        effect: { kind: "unknown", paths: ["src/Service.java"], recoveryId: "tx-unknown" },
        committed: false,
      });
    });

    it("reports a partial effect when only some operations applied before failure", async () => {
      const deps = rearrangeDeps({
        applyEdit: vi.fn(async () => ({
          state: "failed" as const,
          reason: "second operation failed",
          recoveryId: null,
          affectedPaths: ["src/Service.java"],
        })),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({
        ok: false,
        state: "failed",
        effect: { kind: "partial", paths: ["src/Service.java"], recoveryId: null },
        committed: false,
      });
    });

    it("treats a defensive post-hash mismatch as performed, not committed", async () => {
      const deps = rearrangeDeps({
        applyEdit: vi.fn(async () => ({ state: "applied" as const, postText: "third-party text" })),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({
        ok: false,
        state: "failed",
        effect: { kind: "performed", paths: ["src/Service.java"] },
        committed: false,
      });
      if (!result.ok) expect(result.reason).toContain("workspace-edit history/recovery entry");
    });

    it("cleanup mirrors the recovery-required and unknown-effect mapping", async () => {
      const recovery = cleanupDeps({
        applyEdit: vi.fn(async () => ({
          state: "recovery-required" as const,
          reason: "cleanup postcondition mismatch",
          recoveryId: "rec-10",
          affectedPaths: ["src/Service.java"],
        })),
      });
      const recoveryResult = await executeCleanupTransaction(recovery, cleanupInput());
      expect(recoveryResult).toMatchObject({
        ok: false,
        state: "recovery-required",
        effect: { kind: "performed", recoveryId: "rec-10" },
        committed: false,
      });

      const unknown = cleanupDeps({
        applyEdit: vi.fn(async () => ({
          state: "unknown-effect" as const,
          reason: "ack unknown",
          recoveryId: "tx-11",
          affectedPaths: ["src/Service.java"],
        })),
      });
      const unknownResult = await executeCleanupTransaction(unknown, cleanupInput());
      expect(unknownResult).toMatchObject({
        ok: false,
        state: "unknown-effect",
        effect: { kind: "unknown", recoveryId: "tx-11" },
        committed: false,
      });
    });
  });
}
