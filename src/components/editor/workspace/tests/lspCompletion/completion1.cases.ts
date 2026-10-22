import { CompletionContext } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  boostFromSortText,
  boostFromTypedPrefix,
  completionKindToType,
  createLspCompletionSource,
  mergeCompletionTriggers,
  withCompletionAcceptIntent,
  type CompletionRequestIdentity,
} from "../../lspCompletion";
import { status } from "./harness";

export function registerlspCompletionCompletion1Cases() {

  describe("completionKindToType", () => {
    it("maps LSP kinds to CodeMirror types", () => {
      expect(completionKindToType(2)).toBe("method");
      expect(completionKindToType(7)).toBe("class");
      expect(completionKindToType(14)).toBe("keyword");
      expect(completionKindToType(15)).toBe("text");
      expect(completionKindToType(17)).toBe("file");
      expect(completionKindToType(null)).toBeUndefined();
      expect(completionKindToType(99)).toBe("text");
    });
  });

  describe("ED-PARITY-005 completion identity and edit intent", () => {
    const before = "package p;\n\nStringUtiSuffix;";
    const caret = before.indexOf("StringUti") + 9;
    const insert = {
      start: { line: 2, character: 0 }, end: { line: 2, character: 9 },
    };
    const replace = {
      start: { line: 2, character: 0 }, end: { line: 2, character: 15 },
    };
    const importEdit = {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      newText: "import p.StringUtils;\n",
    };
    const item = {
      label: "StringUtils", kind: 7, detail: "p.StringUtils", documentation: null,
      insertText: "StringUtils", insertTextFormat: 1, filterText: null, sortText: null,
      textEdit: { range: insert, newText: "StringUtils" },
      insertReplaceEdit: { insert, replace, newText: "StringUtils" },
      additionalTextEdits: [], raw: { label: "StringUtils" },
    };
    const identity = (generation: number): CompletionRequestIdentity => ({
      workspaceId: "parity005", fileKey: "Main.java", filePath: "/Main.java",
      uri: "file:///Main.java", languageId: "java", documentRevision: 0,
      lspSessionGeneration: 1,
      projectScope: {
        status: "ready", scope: "module", moduleId: "main", sourceKind: "main",
        dependencies: ["commons-lang3"], classpathFingerprint: "classpath-a", generation,
      },
    });

    it("invalidates acceptance when project facts change", async () => {
      const { EditorView } = await import("@codemirror/view");
      let generation = 1;
      const diagnostics = vi.fn();
      const source = createLspCompletionSource({
        identity: () => identity(generation),
        fetch: async () => ({ status: status(true), isIncomplete: false, items: [{ ...item, additionalTextEdits: [importEdit] }] }),
        triggerCharacters: () => [], getDocumentRevision: () => 0,
        reportDiagnostic: diagnostics,
      });
      const state = EditorState.create({ doc: before, selection: { anchor: caret } });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, caret, true));
      generation = 2;
      const option = result!.options[0];
      if (typeof option.apply === "function") option.apply(view, option, caret - 9, caret);
      expect(view.state.doc.toString()).toBe(before);
      expect(diagnostics).toHaveBeenCalledWith("identity-mismatch", "accept");
      view.destroy();
    });

    it("preserves insert replace intent through resolve and undo", async () => {
      const { EditorView } = await import("@codemirror/view");
      const source = createLspCompletionSource({
        identity: () => identity(1),
        fetch: async () => ({ status: status(true), isIncomplete: false, items: [item] }),
        resolve: async () => ({ kind: "resolved", item: { ...item, additionalTextEdits: [importEdit] } }),
        triggerCharacters: () => [], getDocumentRevision: () => 0,
        reportDiagnostic: vi.fn(),
      });
      const state = EditorState.create({ doc: before, selection: { anchor: caret }, extensions: [history()] });
      const view = new EditorView({ state });
      const result = await source(new CompletionContext(state, caret, true));
      const option = result!.options[0];
      withCompletionAcceptIntent(view, "replace", () => {
        if (typeof option.apply === "function") option.apply(view, option, caret - 9, caret);
      });
      await vi.waitFor(() => expect(view.state.doc.toString()).toBe("package p;\nimport p.StringUtils;\n\nStringUtils;"));
      expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from + 11);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(before);
      expect(view.state.selection.main.head).toBe(caret);
      view.destroy();
    });
  });

  describe("boostFromSortText", () => {
    it("ranks lower numeric sortText higher", () => {
      const a = boostFromSortText("0001") ?? 0;
      const b = boostFromSortText("0010") ?? 0;
      expect(a).toBeGreaterThan(b);
    });

    it("returns undefined for empty sortText", () => {
      expect(boostFromSortText(null)).toBeUndefined();
      expect(boostFromSortText("")).toBeUndefined();
    });
  });

  describe("mergeCompletionTriggers", () => {
    it("always includes default triggers and server triggers", () => {
      expect(mergeCompletionTriggers(["("])).toEqual(expect.arrayContaining([".", ":", "("]));
      expect(mergeCompletionTriggers(null)).toEqual(expect.arrayContaining([".", ":"]));
    });
  });

  describe("boostFromTypedPrefix", () => {
    it("prefers exact and camelCase prefix matches", () => {
      const exact = boostFromTypedPrefix("open", "openFile", null) ?? 0;
      const camel = boostFromTypedPrefix("oF", "openFile", null) ?? 0;
      const weak = boostFromTypedPrefix("zz", "openFile", null);
      expect(exact).toBeGreaterThan(camel);
      expect(camel).toBeGreaterThan(0);
      expect(weak).toBeUndefined();
    });

    it("stacks with sortText boost", () => {
      const withSort = boostFromTypedPrefix("to", "toString", "0001") ?? 0;
      const sortOnly = boostFromSortText("0001") ?? 0;
      expect(withSort).toBeGreaterThan(sortOnly);
    });
  });
}
