import { describe, expect, it, vi } from "vitest";
import {
  createFixtureCompletionSource,
  createLspCompletionSource,
  recentCompletionInvocations,
  resetCompletionTelemetry,
  WorkspaceCompletionPolicyController,
} from "../../lspCompletion";
import { completionResult, contextAt, status } from "./harness";

export function registerlspCompletionBehavior3Cases() {

  describe("ED-COMP-004: effective project scope recording", () => {
    const readyScope = {
      status: "ready",
      scope: "module",
      moduleId: "com.example:core",
      sourceKind: "main",
      dependencies: ["org.slf4j:slf4j-api:2.0.7"],
      classpathFingerprint: "cp-core",
      generation: 3,
    } as const;
    const missingScope = {
      status: "scope-facts-missing",
      requestedScope: "module",
      reason: "Project facts not ready (state: loading)",
      fallbackScope: "document",
      generation: 0,
    } as const;

    it("records the effective project scope on the invocation ring (A3)", async () => {
      resetCompletionTelemetry();
      const fetch = vi.fn(async () => completionResult(["openFile"]));
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        projectScope: { ...readyScope, dependencies: [...readyScope.dependencies] },
      });

      await source(contextAt("op", 2, true));

      const invocations = recentCompletionInvocations();
      expect(invocations.length).toBeGreaterThanOrEqual(1);
      const last = invocations[invocations.length - 1];
      expect(last?.projectScope?.status).toBe("ready");
      expect(last?.projectScope).toMatchObject({ moduleId: "com.example:core", generation: 3 });
    });

    it("fires onScopeFallback once for explicit missing-scope requests (A3)", async () => {
      resetCompletionTelemetry();
      const fetch = vi.fn(async () => completionResult(["openFile"]));
      const onScopeFallback = vi.fn();
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        projectScope: { ...missingScope },
        onScopeFallback,
      });

      await source(contextAt("op", 2, true));

      expect(onScopeFallback).toHaveBeenCalledTimes(1);
      expect(onScopeFallback).toHaveBeenCalledWith(
        expect.objectContaining({ status: "scope-facts-missing" }),
        "explicit",
      );
    });

    it("stays silent for typing popups and ready scopes (A3)", async () => {
      resetCompletionTelemetry();
      const fetch = vi.fn(async () => completionResult(["openFile"]));
      const onScopeFallback = vi.fn();

      const typingMissing = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        projectScope: { ...missingScope },
        onScopeFallback,
      });
      await typingMissing(contextAt("op", 2, false));
      expect(onScopeFallback).not.toHaveBeenCalled();

      const explicitReady = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        projectScope: { ...readyScope, dependencies: [...readyScope.dependencies] },
        onScopeFallback,
      });
      await explicitReady(contextAt("op", 2, true));
      expect(onScopeFallback).not.toHaveBeenCalled();
    });

    describe("DEC-02 Member trigger semantics (AC-03, V-03)", () => {
      it("allows trigger reason in shouldAutoTrigger regardless of minPrefixLength (AC-03)", () => {
        const controller = new WorkspaceCompletionPolicyController({
          autoTrigger: true,
          minPrefixLength: 3,
        });

        // Typing with prefix 0 or 1 is blocked by minPrefixLength=3
        expect(controller.shouldAutoTrigger(0, false, "typing")).toBe(false);
        expect(controller.shouldAutoTrigger(1, false, "typing")).toBe(false);
        // Trigger reason is NOT blocked by minPrefixLength
        expect(controller.shouldAutoTrigger(0, false, "trigger")).toBe(true);
        // Explicit is always allowed
        expect(controller.shouldAutoTrigger(0, true, "explicit")).toBe(true);

        // When autoTrigger is disabled, trigger is also blocked
        controller.update({ autoTrigger: false });
        expect(controller.shouldAutoTrigger(0, false, "trigger")).toBe(false);
        // But explicit remains allowed
        expect(controller.shouldAutoTrigger(0, true, "explicit")).toBe(true);
      });

      it("triggers member completion on dot even when minPrefixLength is 3 and supplies triggerCharacter '.'", async () => {
        const fetch = vi.fn(async (_pos, _trigger) => ({
          status: status(true),
          isIncomplete: false,
          items: [{
            label: "now()",
            kind: 2,
            detail: "LocalDateTime",
            documentation: null,
            insertText: "now()",
            insertTextFormat: 1,
            filterText: null,
            sortText: "now",
            textEdit: null,
            additionalTextEdits: [],
            raw: { label: "now()" },
          }],
        }));
        const controller = new WorkspaceCompletionPolicyController({
          autoTrigger: true,
          minPrefixLength: 3,
          triggerDelayMs: 0,
        });
        const source = createLspCompletionSource({
          identity: () => ({
            workspaceId: "ws-probe",
            fileKey: "Probe.java",
            filePath: "/Probe.java",
            uri: "file:///Probe.java",
            languageId: "java",
            documentRevision: 1,
            lspSessionGeneration: 1,
          }),
          fetch,
          triggerCharacters: () => ["."],
          getDocumentRevision: () => 1,
          reportDiagnostic: () => { },
          controller,
        });

        const doc = "LocalDateTime.";
        const result = await source(contextAt(doc, doc.length, false));
        expect(result).not.toBeNull();
        expect(fetch).toHaveBeenCalledWith(
          { line: 0, character: 14 },
          ".",
          expect.anything(),
          expect.objectContaining({ requestedScope: "default" }),
        );
        expect(result?.options.some((o) => o.label === "now()")).toBe(true);
      });

      it("converts trigger-origin explicit startCompletion into triggerKind 2 with '.' trigger character", async () => {
        const fetch = vi.fn(async () => completionResult(["now"]));
        let originChar: string | null = ".";
        const source = createLspCompletionSource({
          identity: () => ({
            workspaceId: "ws-probe",
            fileKey: "Probe.java",
            filePath: "/Probe.java",
            uri: "file:///Probe.java",
            languageId: "java",
            documentRevision: 1,
            lspSessionGeneration: 1,
          }),
          fetch,
          triggerCharacters: () => ["."],
          getDocumentRevision: () => 1,
          reportDiagnostic: () => { },
          consumeTriggerOrigin: () => {
            const c = originChar;
            originChar = null;
            return c;
          },
        });

        const doc = "dt.";
        // startCompletion sets context.explicit = true
        const result = await source(contextAt(doc, doc.length, true));
        expect(result).not.toBeNull();
        // Even though context.explicit was true, consumeTriggerOrigin identified it as trigger-origin
        expect(fetch).toHaveBeenCalledWith(
          { line: 0, character: 3 },
          ".",
          expect.anything(),
          expect.objectContaining({ requestedScope: "default" }),
        );
      });

      it("does not auto-trigger on dot when autoTrigger is false, but manual explicit request still works", async () => {
        const fetch = vi.fn(async () => completionResult(["now"]));
        const controller = new WorkspaceCompletionPolicyController({
          autoTrigger: false,
        });
        const source = createLspCompletionSource({
          identity: () => ({
            workspaceId: "ws-probe",
            fileKey: "Probe.java",
            filePath: "/Probe.java",
            uri: "file:///Probe.java",
            languageId: "java",
            documentRevision: 1,
            lspSessionGeneration: 1,
          }),
          fetch,
          triggerCharacters: () => ["."],
          getDocumentRevision: () => 1,
          reportDiagnostic: () => { },
          controller,
        });

        const doc = "LocalDateTime.";
        // Automatic typing on dot returns null because autoTrigger is false
        expect(await source(contextAt(doc, doc.length, false))).toBeNull();
        expect(fetch).not.toHaveBeenCalled();

        // Manual Ctrl+Space (explicit) still triggers successfully
        const explicitResult = await source(contextAt(doc, doc.length, true));
        expect(explicitResult).not.toBeNull();
        expect(fetch).toHaveBeenCalledWith(
          { line: 0, character: 14 },
          null,
          expect.anything(),
          expect.anything(),
        );
      });
    });
  });
}
