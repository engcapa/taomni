import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../projectAnalysisModel";
import { executeCleanupTransaction, executeRearrangeTransaction, type CleanupExecuteDeps, type RearrangeExecuteDeps } from "../../rearrangeCleanupWorkflow";

export function registerrearrangeCleanupWorkflowLifecycle2Cases() {

  describe("ED-AUDIT-015: executeRearrangeTransaction supported-branch wiring (model boundary)", () => {
    const PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const SWAP_EDITS = [
      {
        range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
        newText: "    public void alpha() {}\n    public void beta() {}",
      },
    ];

    function liveDoc(text: string = PRE, revision = 7) {
      return { text, revision, readOnly: false, dirty: false };
    }

    function supportedCaps() {
      return { rearrangeSupported: true, providerId: "test-arrange", providerVersion: "0" };
    }

    function baseDeps(overrides: Partial<RearrangeExecuteDeps> = {}): RearrangeExecuteDeps {
      return {
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [{ kind: "source.rearrange", title: "Rearrange members", raw: { id: 1 } }],
        })),
        resolveAction: vi.fn(async () => ({
          state: "resolved" as const,
          edits: [...SWAP_EDITS],
        })),
        readLive: vi.fn(() => liveDoc()),
        providerGeneration: vi.fn(() => 3),
        confirmPreview: vi.fn(async () => true),
        applyEdit: vi.fn(async () => ({ state: "applied" as const, postText: POST })),
        ...overrides,
      };
    }

    function baseInput() {
      return {
        scope: "file" as const,
        targetPath: "src/Service.java",
        targetUri: "file:///repo/src/Service.java",
        readOnly: false,
        hasSelection: false,
        capabilities: supportedCaps(),
      };
    }

    it("applies one verified transaction on the supported path", async () => {
      const deps = baseDeps();
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result).toMatchObject({ ok: true, postHash: sha256Hex(POST), operationCount: 1 });
      expect(deps.applyEdit).toHaveBeenCalledTimes(1);
      expect(deps.confirmPreview).toHaveBeenCalledTimes(1);
    });

    it("propagates the resolved LSP document version into the edit handed to apply (ED-MAIN-003)", async () => {
      const applyEdit = vi.fn(async (..._args: unknown[]) => (
        { state: "applied" as const, postText: POST }
      ));
      const deps = baseDeps({
        resolveAction: vi.fn(async () => ({
          state: "resolved" as const,
          edits: [...SWAP_EDITS],
          documentVersion: 7,
        })),
        applyEdit,
      });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result.ok).toBe(true);
      const appliedEdit = applyEdit.mock.calls[0]?.[0] as {
        documentEdits?: Array<{ version?: number; }>;
      } | undefined;
      expect(appliedEdit?.documentEdits?.[0]?.version).toBe(7);
    });

    it("short-circuits missing target and readonly with zero IO", async () => {
      const deps = baseDeps();
      const noTarget = await executeRearrangeTransaction(deps, {
        ...baseInput(),
        targetPath: null as unknown as string,
      });
      expect(noTarget.ok).toBe(false);
      const readOnly = await executeRearrangeTransaction(baseDeps(), {
        ...baseInput(),
        readOnly: true,
      });
      expect(readOnly.ok).toBe(false);
      expect(deps.requestActions).not.toHaveBeenCalled();
    });

    it("discovers source.sortMembers live despite unsupported advertised caps", async () => {
      const deps = baseDeps({
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [{ kind: "source.sortMembers", title: "Sort Members", raw: { id: 9 } }],
        })),
      });
      const result = await executeRearrangeTransaction(deps, {
        ...baseInput(),
        capabilities: { rearrangeSupported: false, providerId: "Eclipse JDT Language Server" },
      });
      expect(result).toMatchObject({ ok: true, postHash: sha256Hex(POST), operationCount: 1 });
      expect(deps.requestActions).toHaveBeenCalledTimes(1);
      expect(deps.applyEdit).toHaveBeenCalledTimes(1);
    });

    it("refuses when the provider returns no rearrange-kind action", async () => {
      const deps = baseDeps({
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [{ kind: "source.organizeImports", title: "Organize imports", raw: {} }],
        })),
      });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.committed).toBe(false);
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses a disabled rearrange candidate at request time before resolve (ED-MAIN-002)", async () => {
      const deps = baseDeps({
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [{
            kind: "source.sortMembers",
            title: "Sort Members",
            raw: { disabled: { reason: "cannot sort now" } },
          }],
        })),
      });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state).toBe("unsupported");
        expect(result.reason).toContain("cannot sort now");
        expect(result.committed).toBe(false);
      }
      expect(deps.resolveAction).not.toHaveBeenCalled();
      expect(deps.applyEdit).not.toHaveBeenCalled();
      expect(deps.confirmPreview).not.toHaveBeenCalled();
    });

    it("skips a disabled candidate when a same-kind enabled action exists (ED-MAIN-002)", async () => {
      const deps = baseDeps({
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [
            { kind: "source.sortMembers", title: "Sort Members (blocked)", raw: { disabled: { reason: "nope" } } },
            { kind: "source.sortMembers", title: "Sort Members", raw: {} },
          ],
        })),
      });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result.ok).toBe(true);
      expect(deps.resolveAction).toHaveBeenCalledTimes(1);
      expect(deps.applyEdit).toHaveBeenCalledTimes(1);
    });

    it("surfaces the standard disabled reason returned only at resolve time (ED-MAIN-002)", async () => {
      const deps = baseDeps({
        resolveAction: vi.fn(async () => ({
          state: "unsupported" as const,
          edits: [],
          reason: "Rearrange Code action 'Sort Members' is disabled by the provider: blocked by the project; nothing applied",
        })),
      });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("blocked by the project");
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses resolve failures and empty edits with zero commits", async () => {
      const failed = baseDeps({
        resolveAction: vi.fn(async () => ({ state: "failed" as const, edits: [], reason: "boom" })),
      });
      expect((await executeRearrangeTransaction(failed, baseInput())).ok).toBe(false);
      const empty = baseDeps({
        resolveAction: vi.fn(async () => ({ state: "resolved" as const, edits: [] })),
      });
      expect((await executeRearrangeTransaction(empty, baseInput())).ok).toBe(false);
      expect(failed.applyEdit).not.toHaveBeenCalled();
      expect(empty.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses dirty-buffer conflicts and stale generations with zero commits", async () => {
      const dirty = baseDeps({ readLive: vi.fn(() => ({ ...liveDoc(), dirty: true })) });
      const dirtyResult = await executeRearrangeTransaction(dirty, baseInput());
      expect(dirtyResult.ok).toBe(false);
      expect(dirty.applyEdit).not.toHaveBeenCalled();

      let generation = 3;
      const stale = baseDeps({
        providerGeneration: vi.fn(() => generation),
        // Flip the generation mid-flight (during resolve, before the
        // freshness gate): the frozen generation no longer matches live.
        resolveAction: vi.fn(async () => {
          generation = 9;
          return { state: "resolved" as const, edits: [...SWAP_EDITS] };
        }),
      });
      expect((await executeRearrangeTransaction(stale, baseInput())).ok).toBe(false);
      expect(stale.applyEdit).not.toHaveBeenCalled();
    });

    it("cancels at the preview gate with zero commits", async () => {
      const deps = baseDeps({ confirmPreview: vi.fn(async () => false) });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result).toEqual({ ok: false, state: "cancelled", reason: "Rearrange cancelled before applying; nothing changed", effect: { kind: "none" }, committed: false });
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("reports postcondition mismatch without claiming success", async () => {
      const deps = baseDeps({
        applyEdit: vi.fn(async () => ({ state: "applied" as const, postText: PRE })),
      });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("postcondition failed");
    });

    it("refuses a closed file with zero commits", async () => {
      const deps = baseDeps({ readLive: vi.fn(() => null) });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      expect(deps.requestActions).not.toHaveBeenCalled();
    });

    it("tolerates a same-text revision bump between freeze and apply", async () => {
      // Background LSP sync may bump the revision without changing a byte;
      // that must re-anchor silently instead of refusing as stale.
      const reads = [liveDoc(PRE, 7), liveDoc(PRE, 7), liveDoc(PRE, 8), liveDoc(PRE, 8)];
      const deps = baseDeps({ readLive: vi.fn(() => reads.shift() ?? liveDoc(PRE, 8)) });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result).toMatchObject({ ok: true, postHash: sha256Hex(POST), operationCount: 1 });
      expect(deps.applyEdit).toHaveBeenCalledTimes(1);
    });

    it("refuses when the text changes between plan and apply", async () => {
      const reads = [liveDoc(PRE, 7), liveDoc(PRE, 7), liveDoc("edited meanwhile", 8)];
      const deps = baseDeps({ readLive: vi.fn(() => reads.shift() ?? liveDoc("edited meanwhile", 8)) });
      const result = await executeRearrangeTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });
  });

  describe("ED-AUDIT-016: executeCleanupTransaction supported-branch wiring (model boundary)", () => {
    const PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const CLEANUP_EDITS = [
      {
        range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
        newText: "    public void alpha() {}\n    public void beta() {}",
      },
    ];

    function liveDoc(text: string = PRE, revision = 7) {
      return { text, revision, readOnly: false, dirty: false };
    }

    function baseDeps(overrides: Partial<CleanupExecuteDeps> = {}): CleanupExecuteDeps {
      return {
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [{ kind: "source.cleanup", title: "Clean up", raw: { id: 1 } }],
        })),
        resolveAction: vi.fn(async () => ({
          state: "resolved" as const,
          edits: [...CLEANUP_EDITS],
        })),
        readLive: vi.fn(() => liveDoc()),
        providerGeneration: vi.fn(() => 3),
        confirmPreview: vi.fn(async () => true),
        applyEdit: vi.fn(async () => ({ state: "applied" as const, postText: POST })),
        ...overrides,
      };
    }

    function baseInput() {
      return {
        scope: "file" as const,
        targetPath: "src/Service.java",
        targetUri: "file:///repo/src/Service.java",
        readOnly: false,
        capabilities: { cleanupSupported: true, providerId: "test-cleanup", providerVersion: "0" },
      };
    }

    it("applies one verified transaction on the supported path", async () => {
      const deps = baseDeps();
      const result = await executeCleanupTransaction(deps, baseInput());
      expect(result).toMatchObject({ ok: true, postHash: sha256Hex(POST), operationCount: 1 });
      expect(deps.applyEdit).toHaveBeenCalledTimes(1);
      expect(deps.confirmPreview).toHaveBeenCalledTimes(1);
    });

    it("short-circuits missing target, readonly, scope, and profile with zero IO", async () => {
      const deps = baseDeps();
      expect((await executeCleanupTransaction(deps, { ...baseInput(), targetPath: null as unknown as string })).ok).toBe(false);
      expect((await executeCleanupTransaction(baseDeps(), { ...baseInput(), readOnly: true })).ok).toBe(false);
      expect((await executeCleanupTransaction(baseDeps(), { ...baseInput(), scope: "project" as const })).ok).toBe(false);
      expect((await executeCleanupTransaction(baseDeps(), { ...baseInput(), profileId: "full-cleanup" })).ok).toBe(false);
      expect(deps.requestActions).not.toHaveBeenCalled();
    });

    it("discovers cleanup kinds live despite unsupported advertised caps", async () => {
      const deps = baseDeps();
      const result = await executeCleanupTransaction(deps, {
        ...baseInput(),
        capabilities: { cleanupSupported: false, providerId: "Eclipse JDT Language Server" },
      });
      expect(result).toMatchObject({ ok: true, postHash: sha256Hex(POST), operationCount: 1 });
      expect(deps.requestActions).toHaveBeenCalledTimes(1);
    });

    it("refuses when the provider returns no cleanup-kind action", async () => {
      const deps = baseDeps({
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [{ kind: "source.organizeImports", title: "Organize imports", raw: {} }],
        })),
      });
      const result = await executeCleanupTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.committed).toBe(false);
        expect(result.reason).toContain("no cleanup action");
      }
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses a disabled cleanup candidate at request time before resolve (ED-MAIN-002)", async () => {
      const deps = baseDeps({
        requestActions: vi.fn(async () => ({
          state: "ok" as const,
          actions: [{
            kind: "source.cleanup",
            title: "Clean up",
            raw: { disabled: { reason: "cleanup is unavailable for this file" } },
          }],
        })),
      });
      const result = await executeCleanupTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state).toBe("unsupported");
        expect(result.reason).toContain("cleanup is unavailable for this file");
        expect(result.committed).toBe(false);
      }
      expect(deps.resolveAction).not.toHaveBeenCalled();
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses resolve failures and empty edits with zero commits", async () => {
      const failed = baseDeps({
        resolveAction: vi.fn(async () => ({ state: "failed" as const, edits: [], reason: "boom" })),
      });
      expect((await executeCleanupTransaction(failed, baseInput())).ok).toBe(false);
      const empty = baseDeps({
        resolveAction: vi.fn(async () => ({ state: "resolved" as const, edits: [] })),
      });
      expect((await executeCleanupTransaction(empty, baseInput())).ok).toBe(false);
      expect(failed.applyEdit).not.toHaveBeenCalled();
      expect(empty.applyEdit).not.toHaveBeenCalled();
    });

    it("reports no-change without claiming fixes", async () => {
      const deps = baseDeps({
        resolveAction: vi.fn(async () => ({
          state: "resolved" as const,
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "" }],
        })),
      });
      const result = await executeCleanupTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("no changes");
      expect(deps.applyEdit).not.toHaveBeenCalled();
      expect(deps.confirmPreview).not.toHaveBeenCalled();
    });

    it("cancels at the preview gate with zero commits", async () => {
      const deps = baseDeps({ confirmPreview: vi.fn(async () => false) });
      const result = await executeCleanupTransaction(deps, baseInput());
      expect(result.ok).toBe(false);
      expect(deps.applyEdit).not.toHaveBeenCalled();
    });

    it("refuses dirty-buffer conflicts and stale generations with zero commits", async () => {
      const dirty = baseDeps({ readLive: vi.fn(() => ({ ...liveDoc(), dirty: true })) });
      expect((await executeCleanupTransaction(dirty, baseInput())).ok).toBe(false);
      expect(dirty.applyEdit).not.toHaveBeenCalled();

      let generation = 3;
      const stale = baseDeps({
        providerGeneration: vi.fn(() => generation),
        // Flip the generation mid-flight (during resolve, before the
        // freshness gate): the frozen generation no longer matches live.
        resolveAction: vi.fn(async () => {
          generation = 9;
          return { state: "resolved" as const, edits: [...CLEANUP_EDITS] };
        }),
      });
      expect((await executeCleanupTransaction(stale, baseInput())).ok).toBe(false);
      expect(stale.applyEdit).not.toHaveBeenCalled();
    });
  });
}
