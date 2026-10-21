import { describe, expect, it, vi } from "vitest";
import type { LspCodeAction, LspDiagnostic } from "../../../../../lib/editor/lsp";
import { buildCapabilityEvidence } from "../../capabilityEvidence";
import { CanonicalCodeActionService, computeStableActionId, isCommandAllowed, type CodeActionCandidate, type CodeActionContextIdentity } from "../../codeActionProviderAdapter";
import { sampleDiagnostic, sampleRange } from "./harness";

export function registercodeActionProviderAdapterBehavior4Cases() {

  describe("§ED-ACTION-001: Canonical Code Action Service Core", () => {
    const service = new CanonicalCodeActionService();

    const sampleContext: CodeActionContextIdentity = {
      document: {
        uri: "file:///workspace/src/Main.java",
        revision: 4,
        languageId: "java",
      },
      provider: {
        id: "jdtls",
        version: "1.61.0",
        generation: 2,
        projectFingerprint: "fp-test-456",
        trusted: true,
      },
      range: sampleRange,
      diagnostics: [sampleDiagnostic],
    };

    it("generates stable deterministic action ID across re-requests and ordering changes", () => {
      const id1 = computeStableActionId({ title: "Import 'List'", kind: "quickfix" }, "jdtls");
      const id2 = computeStableActionId({ title: "Import 'List'", kind: "quickfix" }, "jdtls");
      const idDifferent = computeStableActionId({ title: "Import 'Set'", kind: "quickfix" }, "jdtls");

      expect(id1).toBe(id2);
      expect(id1).not.toBe(idDifferent);
      expect(id1).toMatch(/^codeAction\.jdtls\.[a-f0-9]{16}$/);
    });

    it("validates command-only allowlist with known safe prefixes", () => {
      expect(isCommandAllowed("_java.apply.workspaceEdit")).toBe(true);
      expect(isCommandAllowed("java.apply.workspaceEdit")).toBe(true);
      expect(isCommandAllowed("editor.action.applyWorkspaceEdit")).toBe(true);
      expect(isCommandAllowed("rust-analyzer.applySourceChange")).toBe(true);
      expect(isCommandAllowed("quickfix.addImport")).toBe(true);

      // Disallowed dangerous or arbitrary commands
      expect(isCommandAllowed("shell.executeScript")).toBe(false);
      expect(isCommandAllowed("system.runCommand")).toBe(false);
      expect(isCommandAllowed("")).toBe(false);
    });

    it("refuses to query Java provider for plaintext or unknown files", async () => {
      const plaintextContext: CodeActionContextIdentity = {
        ...sampleContext,
        document: {
          uri: "file:///workspace/README.txt",
          revision: 1,
          languageId: "plaintext",
        },
      };
      const requestCodeActions = vi.fn();

      const res = await service.requestCandidates(plaintextContext, { requestCodeActions });

      expect(res.state).toBe("unsupported");
      if (res.state === "unsupported") {
        expect(res.reason).toContain("plaintext");
      }
      expect(requestCodeActions).not.toHaveBeenCalled();
    });

    it("refuses to query code actions from untrusted provider", async () => {
      const untrustedContext: CodeActionContextIdentity = {
        ...sampleContext,
        provider: {
          ...sampleContext.provider,
          trusted: false,
        },
      };
      const requestCodeActions = vi.fn();

      const res = await service.requestCandidates(untrustedContext, { requestCodeActions });

      expect(res.state).toBe("unsupported");
      if (res.state === "unsupported") {
        expect(res.reason).toContain("untrusted");
      }
      expect(requestCodeActions).not.toHaveBeenCalled();
    });

    it("keeps timeout, throw, null, malformed, and cancellation outcomes distinct", async () => {
      // 1. Throw
      const throwClient = {
        requestCodeActions: vi.fn().mockRejectedValue(new Error("LSP connection dropped")),
      };
      const resThrow = await service.requestCandidates(sampleContext, throwClient);
      expect(resThrow.state).toBe("failed");
      if (resThrow.state === "failed") {
        expect(resThrow.message).toContain("LSP connection dropped");
      }

      // 2. Null is a typed provider response, not an ordinary empty list.
      const nullClient = {
        requestCodeActions: vi.fn().mockResolvedValue(null),
      };
      const resNull = await service.requestCandidates(sampleContext, nullClient);
      expect(resNull.state).toBe("empty");
      if (resNull.state === "empty") {
        expect(resNull.reason).toBe("null-response");
      }

      // 3. A mixed response keeps valid actions and reports discarded entries.
      const malformedClient = {
        requestCodeActions: vi.fn().mockResolvedValue([
          null,
          { title: "" }, // empty title
          { kind: "quickfix" }, // missing title
          { title: "Valid Quickfix", kind: "quickfix" },
        ]),
      };
      const resMalformed = await service.requestCandidates(sampleContext, malformedClient);
      expect(resMalformed.state).toBe("ready");
      if (resMalformed.state === "ready") {
        expect(resMalformed.actions).toHaveLength(1);
        expect(resMalformed.actions[0].action.title).toBe("Valid Quickfix");
        expect(resMalformed.discardedMalformedCount).toBe(3);
      }

      // 4. An entirely malformed response has its own typed state.
      const allMalformed = await service.requestCandidates(sampleContext, {
        requestCodeActions: vi.fn().mockResolvedValue([null, { title: "" }, { kind: "quickfix" }]),
      });
      expect(allMalformed.state).toBe("malformed");
      if (allMalformed.state === "malformed") {
        expect(allMalformed.malformedCount).toBe(3);
      }

      // 5. Timeout
      const timeoutClient = {
        requestCodeActions: vi.fn().mockImplementation(
          (_params, signal?: AbortSignal) => new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve([]), { once: true });
          }),
        ),
      };
      const resTimeout = await service.requestCandidates(sampleContext, timeoutClient, { timeoutMs: 10 });
      expect(resTimeout.state).toBe("timeout");
      if (resTimeout.state === "timeout") {
        expect(resTimeout.cancelled).toBe(true);
      }

      // 6. Caller cancellation is not reported as timeout or failure.
      const abort = new AbortController();
      const cancelledClient = {
        requestCodeActions: vi.fn().mockImplementation(
          (_params, signal?: AbortSignal) => new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve([]), { once: true });
          }),
        ),
      };
      const cancelled = service.requestCandidates(sampleContext, cancelledClient, {
        signal: abort.signal,
      });
      abort.abort();
      await expect(cancelled).resolves.toMatchObject({ state: "cancelled", reason: "aborted" });
    });

    it("freezes request identity before await and deep-freezes the resolved plan", async () => {
      const mutableContext: CodeActionContextIdentity = {
        document: { ...sampleContext.document },
        provider: { ...sampleContext.provider },
        range: {
          start: { ...sampleContext.range.start },
          end: { ...sampleContext.range.end },
        },
        diagnostics: [{ ...sampleDiagnostic }],
        only: ["quickfix"],
      };
      let releaseRequest: ((actions: readonly LspCodeAction[]) => void) | null = null;
      const requestCodeActions = vi.fn(() => new Promise<readonly LspCodeAction[]>((resolve) => {
        releaseRequest = resolve;
      }));
      const pendingRequest = service.requestCandidates(mutableContext, { requestCodeActions });

      mutableContext.document.uri = "file:///mutated.java";
      mutableContext.provider.projectFingerprint = "mutated";
      mutableContext.range.start.line = 99;
      (mutableContext.diagnostics as LspDiagnostic[])[0]!.message = "mutated";
      (mutableContext.only as string[])[0] = "source";
      releaseRequest!([]);

      await expect(pendingRequest).resolves.toMatchObject({ state: "ready" });
      expect(requestCodeActions).toHaveBeenCalledWith(
        expect.objectContaining({
          textDocument: { uri: sampleContext.document.uri },
          range: sampleContext.range,
          context: expect.objectContaining({
            diagnostics: [sampleDiagnostic],
            only: ["quickfix"],
          }),
        }),
        expect.any(AbortSignal),
      );

      const candidate: CodeActionCandidate = {
        id: "codeAction.jdtls.deep-freeze",
        title: "Deep freeze",
        kind: "quickfix",
        disabledReason: null,
        resolveRequired: true,
        rawAction: {
          title: "Deep freeze",
          kind: "quickfix",
          isPreferred: false,
          edit: null,
          command: null,
          commandArguments: null,
          raw: { data: { resolveId: "original" } },
        },
      };
      const planContext: CodeActionContextIdentity = {
        document: { ...sampleContext.document },
        provider: { ...sampleContext.provider },
        range: sampleRange,
        diagnostics: [],
      };
      const resolvedAction: LspCodeAction = {
        ...candidate.rawAction,
        edit: {
          documentEdits: [{
            uri: sampleContext.document.uri,
            path: "/workspace/src/Main.java",
            edits: [{ range: sampleRange, newText: "fixed" }],
          }],
        },
        command: "workspace.afterFix",
        commandArguments: [{ nested: ["value"] }],
      };
      let releaseResolve: ((action: LspCodeAction) => void) | null = null;
      const pendingResolve = service.resolvePlan(
        candidate,
        planContext,
        {
          requestCodeActions: vi.fn(),
          resolveCodeAction: vi.fn(() => new Promise<LspCodeAction>((resolve) => {
            releaseResolve = resolve;
          })),
        },
        planContext.document.revision,
        planContext.provider.generation,
      );
      planContext.document.uri = "file:///mutated-during-resolve.java";
      planContext.provider.projectFingerprint = "mutated-during-resolve";
      candidate.title = "Mutated title";
      releaseResolve!(resolvedAction);

      const resolved = await pendingResolve;
      expect(resolved.state).toBe("resolved");
      if (resolved.state === "resolved") {
        expect(resolved.plan.document.uri).toBe(sampleContext.document.uri);
        expect(resolved.plan.provider.projectFingerprint).toBe(sampleContext.provider.projectFingerprint);
        expect(resolved.plan.actionId).toBe("codeAction.jdtls.deep-freeze");
        expect(Object.isFrozen(resolved.plan.edit?.documentEdits)).toBe(true);
        expect(Object.isFrozen(resolved.plan.edit?.documentEdits[0])).toBe(true);
        expect(Object.isFrozen(resolved.plan.edit?.documentEdits[0]?.edits[0]?.range.start)).toBe(true);
        expect(Object.isFrozen(resolved.plan.command?.arguments)).toBe(true);
        expect(Object.isFrozen((resolved.plan.command?.arguments?.[0] as { nested: string[]; }).nested)).toBe(true);
      }
    });

    it("resolves candidate into an immutable plan and detects stale document / provider generations", async () => {
      const candidate: CodeActionCandidate = {
        id: "codeAction.jdtls.1234567890abcdef",
        title: "Import 'java.util.List'",
        kind: "quickfix",
        isPreferred: true,
        disabledReason: null,
        resolveRequired: true,
        rawAction: {
          title: "Import 'java.util.List'",
          kind: "quickfix",
          isPreferred: true,
          edit: null,
          command: null,
          commandArguments: null,
          raw: { data: { fqn: "java.util.List" } },
        },
        evidence: buildCapabilityEvidence({
          capabilityId: "codeAction.intention",
          languageId: "java",
          provider: { id: "jdtls", version: "1.61.0", generation: 2 },
          projectFingerprint: "fp-test-456",
          uri: "file:///workspace/src/Main.java",
          revision: 4,
          complete: true,
          reason: "ok",
        }),
      };

      const resolvedAction: LspCodeAction = {
        ...candidate.rawAction,
        edit: {
          documentEdits: [
            {
              uri: "file:///workspace/src/Main.java",
              path: "/workspace/src/Main.java",
              edits: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: "import java.util.List;\n",
                },
              ],
            },
          ],
        },
      };

      const client = {
        requestCodeActions: vi.fn(),
        resolveCodeAction: vi.fn().mockResolvedValue(resolvedAction),
      };

      // 1. Success resolve -> returns immutable plan
      const outcome = await service.resolvePlan(candidate, sampleContext, client, 4, 2);
      expect(outcome.state).toBe("resolved");
      if (outcome.state === "resolved") {
        expect(outcome.plan.actionId).toBe(candidate.id);
        expect(outcome.plan.title).toBe(candidate.title);
        expect(outcome.plan.edit).toBeDefined();
        expect(Object.isFrozen(outcome.plan)).toBe(true);
        expect(Object.isFrozen(outcome.plan.document)).toBe(true);
        expect(Object.isFrozen(outcome.plan.provider)).toBe(true);
      }

      // 2. Stale document revision -> blocked
      const staleDocOutcome = await service.resolvePlan(candidate, sampleContext, client, 5, 2);
      expect(staleDocOutcome.state).toBe("stale");
      if (staleDocOutcome.state === "stale") {
        expect(staleDocOutcome.reason).toContain("Document revision changed");
      }

      // 3. Stale provider generation -> blocked
      const staleGenOutcome = await service.resolvePlan(candidate, sampleContext, client, 4, 3);
      expect(staleGenOutcome.state).toBe("stale");
      if (staleGenOutcome.state === "stale") {
        expect(staleGenOutcome.reason).toContain("Provider generation changed");
      }

      // 4. Command allowlist rejection
      const disallowedCommandCandidate: CodeActionCandidate = {
        ...candidate,
        resolveRequired: false,
        rawAction: {
          ...candidate.rawAction,
          command: "unauthorized.system.command",
        },
      };
      const disallowedOutcome = await service.resolvePlan(disallowedCommandCandidate, sampleContext, client, 4, 2);
      expect(disallowedOutcome.state).toBe("rejected");
      if (disallowedOutcome.state === "rejected") {
        expect(disallowedOutcome.reason).toBe("command-disallowed");
      }
    });
  });
}
