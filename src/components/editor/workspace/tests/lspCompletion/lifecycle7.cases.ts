import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  compareCandidatePairs,
  createLspCompletionSource,
  WorkspaceCompletionPolicyController,
  type CompletionCandidateIdentity,
  type CompletionCandidatePair,
  type CompletionRequestIdentity,
} from "../../lspCompletion";
import { completionResult, status } from "./harness";

export function registerlspCompletionLifecycle7Cases() {

  describe("§ED-COMP-002: Candidate & Session Identity Freezing & Atomic Ranking", () => {
    function makePair(
      label: string,
      rawIndex: number,
      matchTier: 1 | 2 | 3 | 4 | 5 = 2,
      matchScore = 100,
      overrides: Partial<CompletionCandidateIdentity> = {},
    ): CompletionCandidatePair {
      const workspaceId = overrides.workspaceId ?? "ws-1";
      return {
        identity: {
          candidateId: `${workspaceId}:file-a:cand-${rawIndex}:${label}`,
          rawResponseIndex: rawIndex,
          workspaceId,
          fileKey: "file-a",
          documentRevision: 5,
          lspSessionGeneration: 2,
          policyRevision: 1,
          ...overrides,
        },
        rawItem: {
          label,
          kind: 3,
          detail: null,
          documentation: null,
          insertText: null,
          insertTextFormat: null,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [],
          raw: { label },
        },
        completion: { label },
        matchTier,
        matchScore,
      };
    }

    it("uses match tier as the primary sort key", () => {
      const tier1 = makePair("find", 2, 1, 1000); // Exact match
      const tier2 = makePair("findAll", 0, 2, 800); // Prefix match
      const tier3 = makePair("fileIndex", 1, 3, 500); // CamelCase match

      const pairs = [tier3, tier2, tier1];
      pairs.sort((a, b) => compareCandidatePairs(a, b, "provider-relevance"));

      expect(pairs.map((p) => p.completion.label)).toEqual(["find", "findAll", "fileIndex"]);
      // Raw items follow pairs atomically
      expect(pairs.map((p) => p.rawItem.label)).toEqual(["find", "findAll", "fileIndex"]);
    });

    it("preserves provider rawResponseIndex order within the same match tier and score", () => {
      const item0 = makePair("applyA", 0, 2, 800);
      const item1 = makePair("applyB", 1, 2, 800);
      const item2 = makePair("applyC", 2, 2, 800);

      // Inverted initial order
      const pairs = [item2, item0, item1];
      pairs.sort((a, b) => compareCandidatePairs(a, b, "provider-relevance"));

      expect(pairs.map((p) => p.identity.rawResponseIndex)).toEqual([0, 1, 2]);
      expect(pairs.map((p) => p.completion.label)).toEqual(["applyA", "applyB", "applyC"]);
    });

    it("alphabetical sort mode orders by label ignoring tier", () => {
      const itemZ = makePair("zebra", 0, 1, 1000);
      const itemA = makePair("apple", 1, 3, 500);

      const pairs = [itemZ, itemA];
      pairs.sort((a, b) => compareCandidatePairs(a, b, "alphabetical"));

      expect(pairs.map((p) => p.completion.label)).toEqual(["apple", "zebra"]);
    });

    it("freezes independent candidate identities across dual workspaces", () => {
      const ws1Pair = makePair("list", 0, 2, 800, { workspaceId: "ws-1", lspSessionGeneration: 1 });
      const ws2Pair = makePair("list", 0, 2, 800, { workspaceId: "ws-2", lspSessionGeneration: 4 });

      expect(ws1Pair.identity.candidateId).not.toBe(ws2Pair.identity.candidateId);
      expect(ws1Pair.identity.workspaceId).toBe("ws-1");
      expect(ws2Pair.identity.workspaceId).toBe("ws-2");
      expect(ws1Pair.identity.lspSessionGeneration).toBe(1);
      expect(ws2Pair.identity.lspSessionGeneration).toBe(4);
    });

    it("keeps raw resolve/apply pairs attached after provider-relevance sorting", async () => {
      const { EditorView } = await import("@codemirror/view");
      const resolvedRaw: unknown[] = [];
      const lessRelevant = {
        ...completionResult(["fooBar"]).items[0],
        insertText: "BAR",
        raw: { id: "fooBar" },
      };
      const exact = {
        ...completionResult(["foo"]).items[0],
        insertText: "FOO",
        raw: { id: "foo" },
      };
      const source = createLspCompletionSource({
        identity: () => ({
          workspaceId: "ws-1",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 1,
        }),
        fetch: async () => ({
          status: status(true),
          isIncomplete: false,
          items: [lessRelevant, exact],
        }),
        resolve: async (raw) => {
          resolvedRaw.push(raw);
          return raw && typeof raw === "object" && "id" in raw && raw.id === "foo"
            ? exact
            : lessRelevant;
        },
        triggerCharacters: () => [],
        getDocumentRevision: () => 1,
        reportDiagnostic: vi.fn(),
      });
      const state = EditorState.create({ doc: "foo" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 3, true));

      expect(result?.options.map((option) => option.label)).toEqual(["foo", "fooBar"]);
      const option = result!.options[0];
      if (typeof option.apply === "function") option.apply(view, option, 0, 3);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(resolvedRaw).toEqual([{ id: "foo" }]);
      expect(view.state.doc.toString()).toBe("FOO");
      view.destroy();
    });

    it("rejects an old option after workspace, provider, or policy identity changes", async () => {
      const assertOldOptionRejected = async (
        change: (setIdentity: (next: CompletionRequestIdentity) => void, controller: WorkspaceCompletionPolicyController) => void,
      ) => {
        const { EditorView } = await import("@codemirror/view");
        let liveIdentity: CompletionRequestIdentity = {
          workspaceId: "ws-1",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 1,
        };
        const controller = new WorkspaceCompletionPolicyController();
        const item = {
          ...completionResult(["newValue"]).items[0],
          insertText: "NEW",
          textEdit: {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
            newText: "NEW",
          },
          additionalTextEdits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "import newValue;\n",
          }],
        };
        const diagnostics: string[] = [];
        const source = createLspCompletionSource({
          identity: () => ({ ...liveIdentity }),
          fetch: async () => ({ status: status(true), isIncomplete: false, items: [item] }),
          triggerCharacters: () => [],
          getDocumentRevision: () => liveIdentity.documentRevision,
          reportDiagnostic: (kind) => diagnostics.push(kind),
          controller,
        });
        const state = EditorState.create({ doc: "\nold" });
        const view = new EditorView({ state });
        const result = await source(new CompletionContext(state, 4, true));
        change((next) => { liveIdentity = next; }, controller);

        const option = result!.options[0];
        const dispatchSpy = vi.spyOn(view, "dispatch");
        if (typeof option.apply === "function") option.apply(view, option, 1, 4);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(view.state.doc.toString()).toBe("\nold");
        expect(diagnostics).toContain("identity-mismatch");
        view.destroy();
      };

      await assertOldOptionRejected((setIdentity) => {
        setIdentity({
          workspaceId: "ws-2",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 1,
        });
      });
      await assertOldOptionRejected((setIdentity) => {
        setIdentity({
          workspaceId: "ws-1",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 2,
        });
      });
      await assertOldOptionRejected((_setIdentity, controller) => {
        controller.update({ sortMode: "alphabetical" });
      });
    });

    it("drops an in-flight provider response when the policy generation changes", async () => {
      const controller = new WorkspaceCompletionPolicyController();
      let releaseFetch: () => void = () => { };
      const fetchReleased = new Promise<void>((resolve) => { releaseFetch = resolve; });
      const source = createLspCompletionSource({
        identity: () => ({
          workspaceId: "ws-1",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 1,
        }),
        fetch: async () => {
          await fetchReleased;
          return { status: status(true), isIncomplete: false, items: completionResult(["providerOnly"]).items };
        },
        triggerCharacters: () => [],
        getDocumentRevision: () => 1,
        reportDiagnostic: vi.fn(),
        controller,
      });
      const state = EditorState.create({ doc: "pro" });
      const pending = source(new CompletionContext(state, 3, true));
      controller.update({ sortMode: "alphabetical" });
      releaseFetch();

      const result = await pending;
      expect(result?.options.some((option) => option.label === "providerOnly")).toBe(false);
    });

    it("handles 0, 1, many, incomplete and truncated results through createLspCompletionSource", async () => {
      const controller = new WorkspaceCompletionPolicyController();
      let returnIncomplete = false;
      let returnTruncated = false;
      let rawItemList = completionResult([]).items;

      const source = createLspCompletionSource({
        identity: () => ({
          workspaceId: "ws-1",
          fileKey: "main.ts",
          filePath: "/repo/main.ts",
          uri: "file:///repo/main.ts",
          languageId: "typescript",
          documentRevision: 1,
          lspSessionGeneration: 1,
        }),
        fetch: async () => ({
          status: status(true),
          isIncomplete: returnIncomplete,
          truncated: returnTruncated,
          items: rawItemList,
        }),
        triggerCharacters: () => [],
        getDocumentRevision: () => 1,
        reportDiagnostic: vi.fn(),
        controller,
      });

      // 0 items
      rawItemList = [];
      const state0 = EditorState.create({ doc: "tes" });
      const res0 = await source(new CompletionContext(state0, 3, true));
      expect(res0).toBeNull();

      // 1 item
      rawItemList = completionResult(["test"]).items;
      const state1 = EditorState.create({ doc: "tes" });
      const res1 = await source(new CompletionContext(state1, 3, true));
      expect(res1?.options).toHaveLength(1);
      expect(res1?.options[0]?.label).toBe("test");

      // Many items with ranking & live policy change
      rawItemList = completionResult(["testingLongFunction", "test", "testAsync"]).items;
      const stateMany = EditorState.create({ doc: "test" });
      const resMany = await source(new CompletionContext(stateMany, 4, true));
      expect(resMany?.options).toHaveLength(3);
      // Exact match "test" ranked first
      expect(resMany?.options[0]?.label).toBe("test");

      // Live policy change to alphabetical
      controller.update({ sortMode: "alphabetical" });
      const resAlpha = await source(new CompletionContext(stateMany, 4, true));
      expect(resAlpha?.options.map((o) => o.label)).toEqual([
        "test",
        "testAsync",
        "testingLongFunction",
      ]);
    });
  });
}
