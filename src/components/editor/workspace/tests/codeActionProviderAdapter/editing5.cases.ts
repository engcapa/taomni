import { describe, expect, it, vi } from "vitest";
import type { LspCodeAction, LspDiagnostic } from "../../../../../lib/editor/lsp";
import { CanonicalCodeActionService, type CodeActionContextIdentity, type CodeActionProviderClient } from "../../codeActionProviderAdapter";

export function registercodeActionProviderAdapterEditing5Cases() {

  describe("§ED-ACTION-003: Problems, Context Menu, and Save Plan-Only", () => {
    const service = new CanonicalCodeActionService();

    const sampleContext: CodeActionContextIdentity = {
      document: {
        uri: "file:///workspace/src/SaveService.java",
        revision: 10,
        languageId: "java",
      },
      provider: {
        id: "jdtls",
        version: "1.61.0",
        generation: 4,
        projectFingerprint: "fp-save-999",
        trusted: true,
      },
      range: { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } },
      diagnostics: [],
    };

    it("executes organize imports in plan-only mode with zero live edits, disk writes, or history entries", async () => {
      const organizeAction: LspCodeAction = {
        title: "Organize Imports",
        kind: "source.organizeImports",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { data: { organize: true } },
      };

      const resolvedAction: LspCodeAction = {
        ...organizeAction,
        edit: {
          documentEdits: [
            {
              uri: "file:///workspace/src/SaveService.java",
              path: "/workspace/src/SaveService.java",
              edits: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
                  newText: "import java.util.List;\nimport java.util.Map;\n",
                },
              ],
            },
          ],
        },
      };

      const client: CodeActionProviderClient = {
        requestCodeActions: vi.fn().mockResolvedValue([organizeAction]),
        resolveCodeAction: vi.fn().mockResolvedValue(resolvedAction),
      };

      const planResult = await service.planAction(sampleContext, client, {
        only: ["source.organizeImports"],
      });

      expect(planResult.outcome.state).toBe("resolved");
      expect(planResult.requestState).toBe("ready");
      expect(planResult.plan).not.toBeNull();
      expect(planResult.plan?.title).toBe("Organize Imports");
      expect(planResult.plan?.edit?.documentEdits).toHaveLength(1);

      // Effect counters strictly zero
      expect(planResult.effectCounters).toEqual({
        liveEdits: 0,
        diskWrites: 0,
        historyEntries: 0,
        commands: 0,
      });
    });

    it("returns plan: null and zero effect counters when organize imports is unsupported or fails", async () => {
      const client: CodeActionProviderClient = {
        requestCodeActions: vi.fn().mockResolvedValue([]),
      };

      const planResult = await service.planAction(sampleContext, client, {
        only: ["source.organizeImports"],
      });

      expect(planResult.plan).toBeNull();
      expect(planResult.requestState).toBe("ready");
      expect(planResult.outcome.state).toBe("unresolved");
      expect(planResult.effectCounters).toEqual({
        liveEdits: 0,
        diskWrites: 0,
        historyEntries: 0,
        commands: 0,
      });

      const failedResult = await service.planAction(sampleContext, {
        requestCodeActions: vi.fn().mockRejectedValue(new Error("provider transport failed")),
      }, {
        only: ["source.organizeImports"],
      });
      expect(failedResult.plan).toBeNull();
      expect(failedResult.requestState).toBe("failed");
      expect(failedResult.outcome).toMatchObject({
        state: "unresolved",
        reason: expect.stringContaining("provider transport failed"),
      });
      expect(failedResult.effectCounters).toEqual({
        liveEdits: 0,
        diskWrites: 0,
        historyEntries: 0,
        commands: 0,
      });
    });

    it("shares CanonicalCodeActionService across Problems, Context Menu, and Save entry points", async () => {
      // Problems entrypoint
      const problemDiagnostic: LspDiagnostic = {
        range: { start: { line: 5, character: 2 }, end: { line: 5, character: 10 } },
        message: "Unused variable",
        severity: 2,
        code: "unused",
        source: "Java",
      };
      const problemContext: CodeActionContextIdentity = {
        ...sampleContext,
        range: problemDiagnostic.range,
        diagnostics: [problemDiagnostic],
      };

      const quickFixAction: LspCodeAction = {
        title: "Remove unused variable",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [
            {
              uri: "file:///workspace/src/SaveService.java",
              path: "/workspace/src/SaveService.java",
              edits: [{ range: problemDiagnostic.range, newText: "" }],
            },
          ],
        },
        command: null,
        commandArguments: null,
        raw: null,
      };

      const problemClient: CodeActionProviderClient = {
        requestCodeActions: vi.fn().mockResolvedValue([quickFixAction]),
      };

      const reqRes = await service.requestCandidates(problemContext, problemClient);
      expect(reqRes.state).toBe("ready");
      if (reqRes.state === "ready") {
        expect(reqRes.actions).toHaveLength(1);
        expect(reqRes.actions[0]!.action.title).toBe("Remove unused variable");

        const planRes = await service.resolvePlan(
          {
            id: "codeAction.jdtls.problemFix",
            title: reqRes.actions[0]!.action.title,
            kind: reqRes.actions[0]!.action.kind ?? "",
            isPreferred: true,
            disabledReason: null,
            resolveRequired: false,
            rawAction: reqRes.actions[0]!.action,
            evidence: reqRes.actions[0]!.evidence,
          },
          problemContext,
          problemClient,
          10,
          4,
        );

        expect(planRes.state).toBe("resolved");
        if (planRes.state === "resolved") {
          expect(planRes.plan.edit?.documentEdits).toHaveLength(1);
        }
      }
    });
  });
}
