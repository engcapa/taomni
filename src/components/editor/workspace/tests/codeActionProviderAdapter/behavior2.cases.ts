import { describe, expect, it, vi } from "vitest";
import { CanonicalCodeActionService, type CodeActionContextIdentity } from "../../codeActionProviderAdapter";

export function registercodeActionProviderAdapterBehavior2Cases() {

  describe("ED-PARITY-007: provider failure classification", () => {
    const service = new CanonicalCodeActionService();
    const context: CodeActionContextIdentity = {
      document: {
        uri: "file:///workspace/src/ExtractTarget.java",
        revision: 4,
        languageId: "java",
      },
      provider: {
        id: "jdtls",
        version: "1.61.0",
        generation: 2,
        projectFingerprint: "fp-parity-007",
        trusted: true,
      },
      range: {
        start: { line: 4, character: 8 },
        end: { line: 7, character: 9 },
      },
      diagnostics: [],
      only: ["refactor.extract"],
    };

    it("classifies a provider 'timed out' rejection as timeout", async () => {
      const res = await service.requestCandidates(context, {
        requestCodeActions: vi.fn().mockRejectedValue(
          new Error("language server request timed out: textDocument/codeAction"),
        ),
      });
      expect(res.state).toBe("timeout");
      expect(res.state).not.toBe("failed");
    });

    it("classifies a document-changed cancellation as cancelled with its real cause", async () => {
      const res = await service.requestCandidates(context, {
        requestCodeActions: vi.fn().mockRejectedValue(
          new Error("language server request cancelled: document changed"),
        ),
      });
      expect(res.state).toBe("cancelled");
      if (res.state === "cancelled") {
        expect(res.detail).toContain("document changed");
      }
    });

    it("keeps an unknown provider rejection as a typed failure carrying the message", async () => {
      const res = await service.requestCandidates(context, {
        requestCodeActions: vi.fn().mockRejectedValue(new Error("boom")),
      });
      expect(res.state).toBe("failed");
      if (res.state === "failed") {
        expect(res.message).toContain("boom");
      }
    });

    it("treats an empty action list as ready with zero candidates", async () => {
      const res = await service.requestCandidates(context, {
        requestCodeActions: vi.fn().mockResolvedValue([]),
      });
      expect(res.state).toBe("ready");
      if (res.state === "ready") {
        expect(res.actions).toHaveLength(0);
      }
    });

    it("keeps a provider-declared disabled reason on the candidate", async () => {
      const res = await service.requestCandidates(context, {
        requestCodeActions: vi.fn().mockResolvedValue([{
          title: "Extract to method",
          kind: "refactor.extract.function",
          isPreferred: false,
          edit: null,
          command: null,
          commandArguments: null,
          raw: {
            title: "Extract to method",
            kind: "refactor.extract.function",
            disabled: { reason: "The selected block has several outputs" },
          },
        }]),
      });
      expect(res.state).toBe("ready");
      if (res.state === "ready") {
        expect(res.actions).toHaveLength(1);
        expect(res.actions[0].disabledReason).toBe("The selected block has several outputs");
      }
    });
  });
}
