import { CompletionContext } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import type { LspCompletionResult } from "../../../../../lib/editor/lsp";
import {
  activeLspSnippetSession,
  advanceLspSnippetTabstop,
  createFixtureCompletionSource,
  createLspCompletionSource,
  type CompletionRequestIdentity,
} from "../../lspCompletion";
import { completionResult, status } from "./harness";

export function registerlspCompletionBehavior5Cases() {

  describe("P0-J1 identity & containment", () => {
    it("falls back to word completion when provider is inactive even with non-empty items", async () => {
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(false),
        isIncomplete: false,
        items: [{
          label: "StaleServerCandidate",
          kind: 7,
          detail: null,
          documentation: null,
          insertText: "StaleServerCandidate",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [],
          raw: {},
        }],
      }));
      const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
      const state = EditorState.create({ doc: "const a = Sta" });
      const result = await source(new CompletionContext(state, 13, true));
      expect(fetch).toHaveBeenCalled();
      const labels = (result?.options ?? []).map((option) => option.label);
      expect(labels).not.toContain("StaleServerCandidate");
    });

    it("discards the whole response when the document revision advanced during fetch", async () => {
      let releaseFetch: () => void = () => { };
      const deferred = new Promise<void>((resolve) => { releaseFetch = resolve; });
      let revision = 1;
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => {
        await deferred;
        return completionResult(["FreshCandidate"]);
      });
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        getDocumentRevision: () => revision,
      });
      const state = EditorState.create({ doc: "const a = Fre" });
      const pending = source(new CompletionContext(state, 13, true));
      revision = 2;
      releaseFetch();
      const result = await pending;
      const labels = (result?.options ?? []).map((option) => option.label);
      expect(labels).not.toContain("FreshCandidate");
    });

    it("shares one resolve result between documentation preview and acceptance", async () => {
      const { EditorView } = await import("@codemirror/view");
      const item = completionResult(["Solo"]).items[0];
      const resolve = vi.fn(async () => ({
        ...item,
        documentation: "Resolved documentation",
      }));
      const source = createFixtureCompletionSource({
        fetch: vi.fn(async () => completionResult(["Solo"])),
        resolve,
        triggerCharacters: () => [],
      });
      const state = EditorState.create({ doc: "Sol" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 3, true));
      const option = result!.options[0];

      expect(typeof option.info).toBe("function");
      const info = await (option.info as () => Promise<Node | null>)();
      expect(info).toHaveTextContent("Resolved documentation");
      if (typeof option.apply === "function") option.apply(view, option, 0, 3);
      await vi.waitFor(() => expect(view.state.doc.toString()).toBe("Solo"));

      expect(resolve).toHaveBeenCalledTimes(1);
      view.destroy();
    });

    it("discards completion documentation when identity changes during resolve", async () => {
      let identity: CompletionRequestIdentity = {
        workspaceId: "workspace-a",
        fileKey: "file-a",
        filePath: "/workspace/a.ts",
        uri: "file:///workspace/a.ts",
        languageId: "typescript",
        documentRevision: 1,
        lspSessionGeneration: 4,
      };
      let releaseResolve: (item: LspCompletionResult["items"][number]) => void = () => { };
      const deferredResolve = new Promise<LspCompletionResult["items"][number]>((resolve) => {
        releaseResolve = resolve;
      });
      const fetch = vi.fn(async () => completionResult(["StaleCandidate"]));
      const source = createLspCompletionSource({
        identity: () => identity,
        fetch,
        resolve: vi.fn(() => deferredResolve),
        triggerCharacters: () => [],
        getDocumentRevision: () => identity.documentRevision,
        reportDiagnostic: vi.fn(),
      });
      const state = EditorState.create({ doc: "Sta" });
      const result = await source(new CompletionContext(state, 3, true));
      const option = result!.options[0];
      expect(typeof option.info).toBe("function");

      const pendingInfo = (option.info as () => Promise<Node | null>)();
      identity = { ...identity, lspSessionGeneration: 5 };
      releaseResolve({
        ...completionResult(["StaleCandidate"]).items[0],
        documentation: "Documentation from the stale provider session",
      });

      expect(await pendingInfo).toBeNull();
    });

    it("reports truncated lists via diagnostic and detail", async () => {
      const diagnostics: string[] = [];
      const items = Array.from({ length: 201 }, (_, i) => ({
        label: `candidate-${i}`,
        kind: 6,
        detail: null,
        documentation: null,
        insertText: `candidate-${i}`,
        insertTextFormat: 1,
        filterText: null,
        sortText: null,
        textEdit: null,
        additionalTextEdits: [],
        raw: {},
      }));
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: true,
        truncated: true,
        items,
      }));
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        reportDiagnostic: (kind) => diagnostics.push(kind),
      });
      const state = EditorState.create({ doc: "can" });
      const result = await source(new CompletionContext(state, 3, true));
      expect(result?.options).toHaveLength(200);
      expect(diagnostics).toContain("truncated");
      expect(result?.options[0]?.detail).toContain("list truncated");
    });
  });

  describe("P0-J1 single-transaction acceptance", () => {
    it("commits snippet placeholder and preceding import edit in one dispatch with mapped selection", async () => {
      const { EditorView } = await import("@codemirror/view");
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          label: "loadUser",
          kind: 3,
          detail: null,
          documentation: null,
          insertText: "loadUser(${1:user})",
          insertTextFormat: 2,
          filterText: null,
          sortText: "0001",
          textEdit: null,
          additionalTextEdits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "import { loadUser } from \"./users\";\n",
          }],
          raw: {},
        }],
      }));
      const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
      const state = EditorState.create({ doc: "\nloadU" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 6, true));
      const option = result!.options[0];
      const dispatchSpy = vi.spyOn(view, "dispatch");
      if (typeof option.apply === "function") {
        option.apply(view, option, 1, 6);
      }
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const doc = view.state.doc.toString();
      expect(doc).toContain("import { loadUser } from \"./users\";");
      expect(doc).toContain("loadUser(user)");
      const importPrefix = "import { loadUser } from \"./users\";\n".length;
      expect(view.state.selection.main.anchor).toBe(importPrefix + 1 + "loadUser(".length);
      view.destroy();
    });

    it("rejects overlapping additional edits with zero document writes", async () => {
      const { EditorView } = await import("@codemirror/view");
      const diagnostics: string[] = [];
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          label: "List",
          kind: 7,
          detail: null,
          documentation: null,
          insertText: "List",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [{
            range: { start: { line: 0, character: 11 }, end: { line: 0, character: 20 } },
            newText: "XXX",
          }],
          raw: {},
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        reportDiagnostic: (kind) => diagnostics.push(kind),
      });
      const state = EditorState.create({ doc: "const a = Lis" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 13, true));
      const option = result!.options[0];
      if (typeof option.apply === "function") {
        option.apply(view, option, 10, 13);
      }
      expect(diagnostics).toContain("invalid-additional-edits");
      expect(view.state.doc.toString()).toBe("const a = Lis");
      view.destroy();
    });

    it("rejects an out-of-bounds primary textEdit with zero document writes", async () => {
      const { EditorView } = await import("@codemirror/view");
      const diagnostics: string[] = [];
      const item = completionResult(["List"]).items[0];
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          ...item,
          textEdit: {
            range: {
              start: { line: 0, character: 10 },
              end: { line: 0, character: 40 },
            },
            newText: "List",
          },
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        resolve: async () => ({
          ...item,
          textEdit: {
            range: {
              start: { line: 0, character: 10 },
              end: { line: 0, character: 40 },
            },
            newText: "List",
          },
        }),
        triggerCharacters: () => [],
        reportDiagnostic: (kind, detail) => diagnostics.push(detail ? `${kind}:${detail}` : kind),
      });
      const state = EditorState.create({ doc: "const a = Lis" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, state.doc.length, true));
      const option = result!.options[0];
      const dispatchSpy = vi.spyOn(view, "dispatch");

      if (typeof option.apply === "function") {
        option.apply(view, option, 10, 13);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe("const a = Lis");
      expect(diagnostics).toContain("invalid-additional-edits:primary-range");
      view.destroy();
    });

    it("rejects colliding zero-width additional edits with zero document writes", async () => {
      const { EditorView } = await import("@codemirror/view");
      const diagnostics: string[] = [];
      const item = completionResult(["List"]).items[0];
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          ...item,
          additionalTextEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "import first;\n",
            },
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "import second;\n",
            },
          ],
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        triggerCharacters: () => [],
        reportDiagnostic: (kind) => diagnostics.push(kind),
      });
      const state = EditorState.create({ doc: "const a = Lis" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, state.doc.length, true));
      const option = result!.options[0];
      const dispatchSpy = vi.spyOn(view, "dispatch");

      if (typeof option.apply === "function") {
        option.apply(view, option, 10, 13);
      }

      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe("const a = Lis");
      expect(diagnostics).toContain("invalid-additional-edits");
      view.destroy();
    });

    it("resolves imports before one acceptance dispatch and one undo", async () => {
      const { EditorView } = await import("@codemirror/view");
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => completionResult(["AutoImportedClass"]));
      const resolvedItem = completionResult(["AutoImportedClass"]).items[0];
      const resolve = vi.fn(async () => ({
        ...resolvedItem,
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "import { AutoImportedClass } from './module';\n",
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        resolve,
        triggerCharacters: () => [],
        getDocumentRevision: () => 0,
      });
      const state = EditorState.create({ doc: "\nAut", extensions: [history()] });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 4, true));
      const option = result!.options[0];
      const dispatchSpy = vi.spyOn(view, "dispatch");
      if (typeof option.apply === "function") option.apply(view, option, 1, 4);
      expect(view.state.doc.toString()).toBe("\nAut");
      await vi.waitFor(() => {
        expect(view.state.doc.toString()).toBe(
          "import { AutoImportedClass } from './module';\n\nAutoImportedClass",
        );
      });
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("\nAut");
      view.destroy();
    });

    it("uses live snippet fields and advances in numeric tabstop order", async () => {
      const { EditorView } = await import("@codemirror/view");
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          ...completionResult(["call"]).items[0],
          label: "call",
          insertText: "call(${1:first}, ${2:second})$0",
          insertTextFormat: 2,
        }],
      }));
      const source = createFixtureCompletionSource({
        fetch,
        resolve: async () => ({
          ...completionResult(["call"]).items[0],
          label: "call",
          insertText: "call(${1:first}, ${2:second})$0",
          insertTextFormat: 2,
        }),
        triggerCharacters: () => [],
      });
      const state = EditorState.create({ doc: "cal" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 3, true));
      const option = result!.options[0];
      if (typeof option.apply === "function") option.apply(view, option, 0, 3);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(view.state.doc.toString()).toBe("call(first, second)");
      expect(view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      )).toBe("first");
      expect(activeLspSnippetSession(view)).toBe(true);
      // Tab advances to the second placeholder with zero document edits.
      expect(advanceLspSnippetTabstop(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("call(first, second)");
      expect(view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      )).toBe("second");
      // The bare $0 stop follows, then the final Tab exits caret-only.
      expect(advanceLspSnippetTabstop(view)).toBe(true);
      expect(view.state.selection.main.head).toBe(view.state.doc.length);
      expect(advanceLspSnippetTabstop(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("call(first, second)");
      expect(activeLspSnippetSession(view)).toBe(false);
      view.destroy();
    });

    it("blocks on resolve failure and surfaces the gate instead of inserting an incomplete acceptance", async () => {
      // §8.19.4: a failed resolve must NOT fall through to a silent
      // primary-only insert — the gate waits for an explicit user choice.
      const { EditorView } = await import("@codemirror/view");
      const diagnostics: string[] = [];
      const gates: Array<{ reason: string; insertWithoutImport(): boolean; }> = [];
      const fetch = vi.fn(async (): Promise<LspCompletionResult> => completionResult(["Solo"]));
      const resolve = vi.fn(async () => { throw new Error("resolve blew up"); });
      const source = createLspCompletionSource({
        identity: () => ({
          workspaceId: "fixture-workspace",
          fileKey: "fixture-file",
          filePath: "/fixture/file.ts",
          uri: "file:///fixture/file.ts",
          languageId: "fixture",
          documentRevision: 0,
          lspSessionGeneration: 0,
        }),
        fetch: () => fetch(),
        resolve: () => resolve(),
        triggerCharacters: () => [],
        getDocumentRevision: () => 0,
        reportDiagnostic: (kind, detail) => diagnostics.push(detail ? `${kind}:${detail}` : kind),
        onResolveGate: (request) => gates.push(request),
      });
      const state = EditorState.create({ doc: "const a = Sol" });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, 13, true));
      const option = result!.options[0];
      if (typeof option.apply === "function") {
        option.apply(view, option, 10, 13);
      }
      await new Promise((r) => setTimeout(r, 10));
      // Nothing inserted while the gate is pending.
      expect(view.state.doc.toString()).toBe("const a = Sol");
      expect(gates).toHaveLength(1);
      expect(gates[0].reason).toBe("failed");
      expect(diagnostics).toContain("additional-edit-unavailable:resolve-failed");
      view.destroy();
    });
  });
}
