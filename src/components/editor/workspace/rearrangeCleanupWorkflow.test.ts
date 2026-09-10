import { describe, expect, it, vi } from "vitest";
import {
  buildCleanupPlan,
  buildRearrangePlan,
  cancelWorkflowPlan,
  executeCleanupTransaction,
  executeRearrangeTransaction,
  planCleanup,
  planRearrange,
  resolveCleanupCapabilities,
  resolveRearrangeCapabilities,
  verifyWorkflowFreshness,
  verifyWorkflowPostHashes,
  verifyWorkflowPreconditions,
  type CleanupExecuteDeps,
  type CleanupInput,
  type RearrangeExecuteDeps,
  type RearrangeInput,
} from "./rearrangeCleanupWorkflow";
import { sha256Hex } from "./projectAnalysisModel";

describe("ED-STYLE-002: Rearrange / Cleanup independent workflows", () => {
  describe("resolveRearrangeCapabilities", () => {
    it("resolves supported when codeActionKinds includes source.rearrange", () => {
      const caps = resolveRearrangeCapabilities(
        {
          completion: true,
          signatureHelp: true,
          hover: true,
          definition: true,
          typeDefinition: true,
          implementation: true,
          references: true,
          documentSymbol: true,
          workspaceSymbol: true,
          rename: true,
          formatting: true,
          rangeFormatting: true,
          codeAction: true,
          documentHighlight: true,
          callHierarchy: true,
          typeHierarchy: true,
          inlayHint: true,
          selectionRange: true,
          semanticTokens: true,
          completionTriggerCharacters: [],
          signatureTriggerCharacters: [],
          codeActionKinds: ["source.rearrange"],
        },
        {
          path: "/repo/App.java",
          uri: "file:///repo/App.java",
          presetId: "jdtls",
          languageId: "java",
          displayName: "Eclipse JDT Language Server",
          available: true,
          active: true,
          selectedCommandId: null,
          selectedCommand: null,
          installHint: null,
          error: null,
        },
      );
      expect(caps.rearrangeSupported).toBe(true);
      expect(caps.providerId).toBe("Eclipse JDT Language Server");
    });

    it("resolves unsupported when server advertises only standard actions", () => {
      const caps = resolveRearrangeCapabilities(
        {
          completion: true,
          signatureHelp: true,
          hover: true,
          definition: true,
          typeDefinition: true,
          implementation: true,
          references: true,
          documentSymbol: true,
          workspaceSymbol: true,
          rename: true,
          formatting: true,
          rangeFormatting: true,
          codeAction: true,
          documentHighlight: true,
          callHierarchy: true,
          typeHierarchy: true,
          inlayHint: true,
          selectionRange: true,
          semanticTokens: true,
          completionTriggerCharacters: [],
          signatureTriggerCharacters: [],
          codeActionKinds: ["source.organizeImports", "refactor"],
        },
        {
          path: "/repo/App.java",
          uri: "file:///repo/App.java",
          presetId: "jdtls",
          languageId: "java",
          displayName: "Eclipse JDT Language Server",
          available: true,
          active: true,
          selectedCommandId: null,
          selectedCommand: null,
          installHint: null,
          error: null,
        },
      );
      expect(caps.rearrangeSupported).toBe(false);
      expect(caps.providerId).toBe("Eclipse JDT Language Server");
    });
  });

  describe("resolveCleanupCapabilities", () => {
    it("resolves supported when codeActionKinds includes source.cleanup or source.fixAll", () => {
      const caps = resolveCleanupCapabilities({
        completion: true,
        signatureHelp: true,
        hover: true,
        definition: true,
        typeDefinition: true,
        implementation: true,
        references: true,
        documentSymbol: true,
        workspaceSymbol: true,
        rename: true,
        formatting: true,
        rangeFormatting: true,
        codeAction: true,
        documentHighlight: true,
        callHierarchy: true,
        typeHierarchy: true,
        inlayHint: true,
        selectionRange: true,
        semanticTokens: true,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
        codeActionKinds: ["source.cleanup"],
      });
      expect(caps.cleanupSupported).toBe(true);
      expect(caps.supportedProfiles).toContain("default");
    });

    it("resolves unsupported when null capabilities provided", () => {
      const caps = resolveCleanupCapabilities(null);
      expect(caps.cleanupSupported).toBe(false);
    });
  });

  describe("planRearrange (ED-STYLE-002-A1, A2)", () => {
    it("fails closed when rearrange is unsupported by provider with honest reason", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: false,
        capabilities: { rearrangeSupported: false },
      };

      const decision = planRearrange(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("No member-rearrangement provider is available");
      }
    });

    it("names the provider in the unavailable explanation when providerId is provided", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: false,
        capabilities: {
          rearrangeSupported: false,
          providerId: "Eclipse JDT Language Server",
        },
      };

      const decision = planRearrange(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("Eclipse JDT Language Server does not support member-rearrangement for java");
      }
    });

    it("rejects read-only files honestly", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/libs/String.class",
        languageId: "java",
        readOnly: true,
        hasSelection: false,
        capabilities: { rearrangeSupported: true },
      };

      const decision = planRearrange(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("is read-only");
      }
    });

    it("executes when provider explicitly advertises rearrange capability", () => {
      const input: RearrangeInput = {
        scope: "selection",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: true,
        capabilities: { rearrangeSupported: true },
      };

      const decision = planRearrange(input);
      expect(decision).toEqual({
        kind: "execute",
        scope: "selection",
        stage: "rearrange",
      });
    });

    it("executes with provider metadata when supplied", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: false,
        capabilities: {
          rearrangeSupported: true,
          providerId: "Java Arrangement Server",
          providerVersion: "2.1.0",
        },
      };

      const decision = planRearrange(input);
      expect(decision).toEqual({
        kind: "execute",
        scope: "file",
        stage: "rearrange",
        provider: {
          id: "Java Arrangement Server",
          version: "2.1.0",
        },
      });
    });
  });

  describe("planCleanup (ED-STYLE-002-A1, A2)", () => {
    it("fails closed when cleanup is unsupported by provider", () => {
      const input: CleanupInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        capabilities: { cleanupSupported: false },
      };

      const decision = planCleanup(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("No code cleanup provider is available");
      }
    });

    it("names the provider in the cleanup unavailable explanation", () => {
      const input: CleanupInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        capabilities: {
          cleanupSupported: false,
          providerId: "Eclipse JDT Language Server",
        },
      };

      const decision = planCleanup(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("Eclipse JDT Language Server does not support code cleanup for java");
      }
    });

    it("executes when cleanup is supported with profile", () => {
      const input: CleanupInput = {
        scope: "module",
        targetPath: "/repo/app",
        languageId: "java",
        readOnly: false,
        profileId: "full-cleanup",
        capabilities: { cleanupSupported: true, supportedProfiles: ["full-cleanup"] },
      };

      const decision = planCleanup(input);
      expect(decision).toEqual({
        kind: "execute",
        scope: "module",
        stage: "cleanup",
        profileId: "full-cleanup",
      });
    });
  });

  describe("workflow plan, preview, conflict, and cancel (ED-STYLE-002-A3)", () => {
    const originalText = "class Example {\n  void b() {}\n  void a() {}\n}\n";
    const rearrangedText = "class Example {\n  void a() {}\n  void b() {}\n}\n";

    it("builds rearrange plan with preview and preconditions", () => {
      const plan = buildRearrangePlan({
        scope: "file",
        targetPath: "/repo/src/Example.java",
        targetUri: "file:///repo/src/Example.java",
        currentText: originalText,
        documentRevision: 1,
        readOnly: false,
        provider: { id: "ArrangementProvider", version: "1.0.0" },
        edits: [
          {
            range: {
              start: { line: 1, character: 0 },
              end: { line: 3, character: 0 },
            },
            newText: "  void a() {}\n  void b() {}\n",
          },
        ],
      });

      expect(plan.workflow).toBe("rearrange");
      expect(plan.provider.id).toBe("ArrangementProvider");
      expect(plan.preconditions).toHaveLength(1);
      expect(plan.preconditions[0].preTextSha256).toBe(sha256Hex(originalText));
      expect(plan.preconditions[0].expectedPostHash).toBe(sha256Hex(rearrangedText));
      expect(plan.conflicts).toHaveLength(0);
      expect(plan.preview.entries).toHaveLength(1);
      expect(plan.preview.entries[0].path).toBe("/repo/src/Example.java");
    });

    it("detects dirty buffer or read-only conflict at plan generation", () => {
      const planDirty = buildRearrangePlan({
        scope: "file",
        targetPath: "/repo/src/Example.java",
        targetUri: "file:///repo/src/Example.java",
        currentText: originalText,
        readOnly: false,
        isDirty: true,
        provider: { id: "p" },
        edits: [],
      });
      expect(planDirty.conflicts).toHaveLength(1);
      expect(planDirty.conflicts[0].reason).toBe("dirty-open-buffer");

      const planReadOnly = buildCleanupPlan({
        scope: "file",
        targetPath: "/repo/src/ReadOnly.java",
        targetUri: "file:///repo/src/ReadOnly.java",
        currentText: originalText,
        readOnly: true,
        provider: { id: "p" },
        edits: [],
      });
      expect(planReadOnly.conflicts).toHaveLength(1);
      expect(planReadOnly.conflicts[0].reason).toBe("read-only");
    });

    it("verifies preconditions and catches external divergence", () => {
      const plan = buildRearrangePlan({
        scope: "file",
        targetPath: "/repo/src/Example.java",
        targetUri: "file:///repo/src/Example.java",
        currentText: originalText,
        documentRevision: 2,
        readOnly: false,
        provider: { id: "p" },
        edits: [],
      });

      // Valid live document matching precondition
      const valid = verifyWorkflowPreconditions(plan, {
        "/repo/src/Example.java": { text: originalText, revision: 2 },
      });
      expect(valid.ok).toBe(true);

      // Diverged live text
      const diverged = verifyWorkflowPreconditions(plan, {
        "/repo/src/Example.java": { text: originalText + "// edited\n", revision: 2 },
      });
      expect(diverged.ok).toBe(false);
      expect(diverged.conflict?.reason).toBe("external-divergence");

      // Version mismatch
      const versionMismatch = verifyWorkflowPreconditions(plan, {
        "/repo/src/Example.java": { text: originalText, revision: 3 },
      });
      expect(versionMismatch.ok).toBe(false);
      expect(versionMismatch.conflict?.reason).toBe("version-mismatch");
    });

    it("detects stale provider session or generation", () => {
      const fresh = verifyWorkflowFreshness(
        { providerGeneration: 1, sessionId: "sess-1" },
        { providerGeneration: 1, sessionId: "sess-1" },
      );
      expect(fresh.ok).toBe(true);

      const staleGen = verifyWorkflowFreshness(
        { providerGeneration: 1, sessionId: "sess-1" },
        { providerGeneration: 2, sessionId: "sess-1" },
      );
      expect(staleGen.ok).toBe(false);
      expect(staleGen.staleReason).toContain("Provider generation changed");

      const staleSess = verifyWorkflowFreshness(
        { sessionId: "sess-1" },
        { sessionId: "sess-2" },
      );
      expect(staleSess.ok).toBe(false);
      expect(staleSess.staleReason).toContain("Session identity changed");
    });

    it("cancels plan with zero effects", () => {
      const plan = buildRearrangePlan({
        scope: "file",
        targetPath: "/repo/src/Example.java",
        targetUri: "file:///repo/src/Example.java",
        currentText: originalText,
        readOnly: false,
        provider: { id: "p" },
        edits: [],
      });

      const cancelResult = cancelWorkflowPlan(plan);
      expect(cancelResult.disposition).toBe("cancelled");
      expect(cancelResult.applied).toBe(false);
      expect(cancelResult.effects).toHaveLength(0);
    });
  });

  describe("postcondition verification and undo (ED-STYLE-002-A4)", () => {
    it("verifies postcondition hashes against applied files", () => {
      const originalText = "void test() {}";
      const cleanedText = "void test() {\n    // cleaned\n}";
      const expectedHash = sha256Hex(cleanedText);

      const success = verifyWorkflowPostHashes(
        { "/repo/src/Test.java": expectedHash },
        { "/repo/src/Test.java": cleanedText },
      );
      expect(success.ok).toBe(true);
      expect(success.mismatchedFiles).toHaveLength(0);

      const mismatch = verifyWorkflowPostHashes(
        { "/repo/src/Test.java": expectedHash },
        { "/repo/src/Test.java": originalText },
      );
      expect(mismatch.ok).toBe(false);
      expect(mismatch.mismatchedFiles).toContain("/repo/src/Test.java");
    });
  });
});


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
