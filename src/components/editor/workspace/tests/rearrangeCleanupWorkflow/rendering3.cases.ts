import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../projectAnalysisModel";
import { executeCleanupTransaction, executeRearrangeTransaction, type CleanupExecuteDeps, type RearrangeExecuteDeps } from "../../rearrangeCleanupWorkflow";

export function registerrearrangeCleanupWorkflowRendering3Cases() {

  // ---------------------------------------------------------------------------
  // ED-IMPROVE-001: every await window re-verifies the frozen identity, and the
  // shared apply boundary performs the final pre-mutation check. Baseline
  // regression: a preview-window text change used to commit the old edits.
  // ---------------------------------------------------------------------------
  describe("ED-IMPROVE-001: frozen identity across request/resolve/preview (model boundary)", () => {
    const PRE = "package com.example;\n\npublic class Service {\n    void beta() {}\n    void alpha() {}\n}\n";
    const POST = "package com.example;\n\npublic class Service {\n    void alpha() {}\n    void beta() {}\n}\n";
    const EDITS = [
      {
        range: { start: { line: 3, character: 0 }, end: { line: 4, character: 19 } },
        newText: "    void alpha() {}\n    void beta() {}",
      },
    ];

    function live(text: string, revision = 7) {
      return { text, revision, readOnly: false, dirty: false };
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
        applyEdit: vi.fn(async () => ({ state: "applied" as const, postText: POST })),
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
        applyEdit: vi.fn(async () => ({ state: "applied" as const, postText: POST })),
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

    it("refuses text changed during the provider request window", async () => {
      let text = PRE;
      const deps = rearrangeDeps({
        readLive: vi.fn(() => live(text)),
        requestActions: vi.fn(async () => {
          text = "class XY {}";
          return { state: "ok" as const, actions: [{ kind: "source.sortMembers", title: "Sort Members", raw: {} }] };
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: false, state: "stale", committed: false });
      expect(deps.applyEdit).not.toHaveBeenCalled();
      expect(deps.confirmPreview).not.toHaveBeenCalled();
    });

    it("refuses text changed during the provider resolve window", async () => {
      let text = PRE;
      const deps = rearrangeDeps({
        readLive: vi.fn(() => live(text)),
        resolveAction: vi.fn(async () => {
          text = "class XY {}";
          return { state: "resolved" as const, edits: [...EDITS] };
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: false, state: "stale", committed: false });
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses text changed during the preview confirmation window", async () => {
      let text = PRE;
      const deps = rearrangeDeps({
        readLive: vi.fn(() => live(text)),
        confirmPreview: vi.fn(async () => {
          text = "class XY {}";
          return true;
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: false, state: "stale", committed: false });
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses provider generation changes during the preview confirmation window", async () => {
      let generation = 3;
      const deps = rearrangeDeps({
        providerGeneration: vi.fn(() => generation),
        confirmPreview: vi.fn(async () => {
          generation = 4;
          return true;
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: false, state: "stale", committed: false });
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses a closed file or workspace switch during the preview window", async () => {
      let current: ReturnType<typeof live> | null = live(PRE);
      const deps = rearrangeDeps({
        readLive: vi.fn(() => current),
        confirmPreview: vi.fn(async () => {
          current = null;
          return true;
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: false, state: "cancelled", committed: false });
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses a read-only toggle during the preview window", async () => {
      let readOnly = false;
      const deps = rearrangeDeps({
        readLive: vi.fn(() => ({ ...live(PRE), readOnly })),
        confirmPreview: vi.fn(async () => {
          readOnly = true;
          return true;
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: false, state: "conflict", committed: false });
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses a request superseded by a newer one (double-entry)", async () => {
      let token = 1;
      const deps = rearrangeDeps({
        requestToken: () => token,
        confirmPreview: vi.fn(async () => {
          token = 2;
          return true;
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: false, state: "stale", committed: false });
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("re-verifies identity inside the shared apply boundary before mutation", async () => {
      let text = PRE;
      const deps = rearrangeDeps({
        readLive: vi.fn(() => live(text)),
        applyEdit: vi.fn(async (_edit, guard) => {
          text = "late external edit";
          expect(() => guard.assertCurrent()).toThrow(/changed since/);
          return { state: "failed" as const, reason: "preflight rejected" };
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: false, state: "stale", committed: false });
    });

    it("tolerates a same-text revision bump during the preview window", async () => {
      let revision = 7;
      const deps = rearrangeDeps({
        readLive: vi.fn(() => live(PRE, revision)),
        confirmPreview: vi.fn(async () => {
          revision = 9;
          return true;
        }),
      });
      const result = await executeRearrangeTransaction(deps, rearrangeInput());
      expect(result).toMatchObject({ ok: true, postHash: sha256Hex(POST), operationCount: 1 });
    });

    it("cleanup mirrors the preview-window identity refusal", async () => {
      let text = PRE;
      const deps = cleanupDeps({
        readLive: vi.fn(() => live(text)),
        confirmPreview: vi.fn(async () => {
          text = "class XY {}";
          return true;
        }),
      });
      const result = await executeCleanupTransaction(deps, cleanupInput());
      expect(result).toMatchObject({ ok: false, state: "stale", committed: false });
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("cleanup mirrors closed-file, read-only, token and generation refusals", async () => {
      const failureState = async (deps: CleanupExecuteDeps): Promise<string> => {
        const result = await executeCleanupTransaction(deps, cleanupInput());
        return result.ok ? "ok" : result.state;
      };
      let current: ReturnType<typeof live> | null = live(PRE);
      const closed = cleanupDeps({
        readLive: vi.fn(() => current),
        confirmPreview: vi.fn(async () => {
          current = null;
          return true;
        }),
      });
      expect(await failureState(closed)).toBe("cancelled");

      let readOnly = false;
      const readonly = cleanupDeps({
        readLive: vi.fn(() => ({ ...live(PRE), readOnly })),
        confirmPreview: vi.fn(async () => {
          readOnly = true;
          return true;
        }),
      });
      expect(await failureState(readonly)).toBe("conflict");

      let token = 1;
      const superseded = cleanupDeps({
        requestToken: () => token,
        confirmPreview: vi.fn(async () => {
          token = 2;
          return true;
        }),
      });
      expect(await failureState(superseded)).toBe("stale");

      let generation = 3;
      const stale = cleanupDeps({
        providerGeneration: vi.fn(() => generation),
        confirmPreview: vi.fn(async () => {
          generation = 4;
          return true;
        }),
      });
      expect(await failureState(stale)).toBe("stale");
      expect(closed.applyEdit).not.toHaveBeenCalled();
      expect(readonly.applyEdit).not.toHaveBeenCalled();
      expect(superseded.applyEdit).not.toHaveBeenCalled();
      expect(stale.applyEdit).not.toHaveBeenCalled();
    });

    it("cleanup re-verifies identity inside the shared apply boundary", async () => {
      let text = PRE;
      const deps = cleanupDeps({
        readLive: vi.fn(() => live(text)),
        applyEdit: vi.fn(async (_edit, guard) => {
          text = "late external edit";
          expect(() => guard.assertCurrent()).toThrow(/changed since/);
          return { state: "failed" as const, reason: "preflight rejected" };
        }),
      });
      const result = await executeCleanupTransaction(deps, cleanupInput());
      expect(result).toMatchObject({ ok: false, state: "stale", committed: false });
    });
  });
}
