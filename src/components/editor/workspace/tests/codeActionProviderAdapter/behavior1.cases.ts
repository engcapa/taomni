import { describe, expect, it } from "vitest";
import type { LspCodeAction } from "../../../../../lib/editor/lsp";
import { buildCodeActionClientCapabilities, buildCodeActionParams, evaluateCodeActionResult } from "../../codeActionProviderAdapter";
import { sampleDiagnostic, sampleRange, testEvidenceInput } from "./harness";

export function registercodeActionProviderAdapterBehavior1Cases() {

  describe("§8.21.4 V3 codeActionProviderAdapter", () => {
    it("builds canonical request params and client capabilities", () => {
      const params = buildCodeActionParams("file:///test.java", sampleRange, [sampleDiagnostic], ["quickfix", " "]);
      expect(params.textDocument.uri).toBe("file:///test.java");
      expect(params.range).toEqual(sampleRange);
      expect(params.context.diagnostics).toEqual([sampleDiagnostic]);
      expect(params.context.only).toEqual(["quickfix"]);

      const capabilities = buildCodeActionClientCapabilities();
      expect(capabilities.dynamicRegistration).toBe(true);
      expect(capabilities.isPreferredSupport).toBe(true);
      expect(capabilities.dataSupport).toBe(true);
      expect((capabilities.codeActionLiteralSupport as any)?.codeActionKind?.valueSet).toContain("quickfix");
    });

    it("evaluates ready provider outcome into CodeActionProviderResultV4", () => {
      const action: LspCodeAction = {
        title: "Import 'StringUtils'",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { data: { fqn: "org.apache.commons.lang3.StringUtils" } },
      };
      const result = evaluateCodeActionResult(
        { kind: "ready", actions: [action] },
        testEvidenceInput,
      );

      expect(result.state).toBe("ready");
      if (result.state === "ready") {
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0].action.title).toBe("Import 'StringUtils'");
        expect(result.actions[0].evidence.capabilityId).toBe("codeAction.intention");
        expect(result.actions[0].evidence.coverage.complete).toBe(true);
      }
    });

    it("evaluates unsupported provider outcome with actionable reason", () => {
      const result = evaluateCodeActionResult(
        { kind: "unsupported", reason: "Language server version (jdtls 1.61) does not support codeAction" },
        testEvidenceInput,
      );

      expect(result.state).toBe("unsupported");
      if (result.state === "unsupported") {
        expect(result.reason).toContain("jdtls 1.61");
        expect(result.evidence.coverage.complete).toBe(false);
        expect(result.evidence.coverage.reason).toContain("jdtls 1.61");
      }
    });

    it("evaluates timeout outcome with cancellation tracking and retry policy", () => {
      const result = evaluateCodeActionResult(
        {
          kind: "timeout",
          requestId: "ca-req-999",
          cancelled: true,
          providerStillHealthy: true,
          retryAfter: "manual",
        },
        testEvidenceInput,
      );

      expect(result.state).toBe("timeout");
      if (result.state === "timeout") {
        expect(result.requestId).toBe("ca-req-999");
        expect(result.cancelled).toBe(true);
        expect(result.providerStillHealthy).toBe(true);
        expect(result.retryAfter).toBe("manual");
      }
    });

    it("evaluates failed outcome without faking actions", () => {
      const result = evaluateCodeActionResult(
        { kind: "failed", message: "Server connection reset", providerStillHealthy: false },
        testEvidenceInput,
      );

      expect(result.state).toBe("failed");
      if (result.state === "failed") {
        expect(result.message).toBe("Server connection reset");
        expect(result.providerStillHealthy).toBe(false);
      }
    });
  });
}
