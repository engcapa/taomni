import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { LspCompletionResult } from "../../../../../lib/editor/lsp";
import {
  LspCompletionController,
  WorkspaceCompletionPolicyController,
  compareCompletionCandidates,
  createLspCompletionSource,
  matchCompletionQuery,
  matchesCaseRule,
  matchesSymbolPattern,
  symbolIdentityFromItem,
  type CompletionRequestIdentity,
} from "../../lspCompletion";
import { status } from "./harness";

export function registerlspCompletionCompletion6Cases() {
  it("extracts symbol identity and matches patterns safely without false label exclusion", () => {
    const qualifiedItem = {
      label: "List",
      kind: 7,
      detail: "java.awt.List",
      documentation: null,
      insertText: null,
      insertTextFormat: null,
      filterText: null,
      sortText: null,
      textEdit: null,
      additionalTextEdits: [],
      raw: { data: { fqn: "java.awt.List" } },
    };
    const unqualifiedItem = {
      label: "List",
      kind: 7,
      detail: null,
      documentation: null,
      insertText: null,
      insertTextFormat: null,
      filterText: null,
      sortText: null,
      textEdit: null,
      additionalTextEdits: [],
      raw: {},
    };

    const qIdentity = symbolIdentityFromItem(qualifiedItem);
    expect(qIdentity.hasPackageIdentity).toBe(true);
    expect(qIdentity.fqn).toBe("java.awt.List");

    const uIdentity = symbolIdentityFromItem(unqualifiedItem);
    expect(uIdentity.hasPackageIdentity).toBe(false);

    const patterns = [{ pattern: "java.awt.*" }];
    expect(matchesSymbolPattern(qIdentity, patterns)).toBe(true);
    // Unqualified symbol is NOT excluded just because label is "List"
    expect(matchesSymbolPattern(uIdentity, patterns)).toBe(false);
  });

  it("applies case matching rules: first-letter, all, none", () => {
    expect(matchesCaseRule("list", "listItems", "first-letter")).toBe(true);
    expect(matchesCaseRule("list", "ListItems", "first-letter")).toBe(false);
    expect(matchesCaseRule("List", "ListItems", "first-letter")).toBe(true);

    expect(matchesCaseRule("list", "listItems", "all")).toBe(true);
    expect(matchesCaseRule("list", "ListItems", "all")).toBe(false);

    expect(matchesCaseRule("list", "ListItems", "none")).toBe(true);
  });

  it("filters excluded symbols, boosts prioritized symbols, and sorts alphabetical vs provider-relevance", async () => {
    const { EditorView } = await import("@codemirror/view");
    const items = [
      {
        label: "AwtList",
        kind: 7,
        detail: "java.awt.List",
        documentation: null,
        insertText: null,
        insertTextFormat: null,
        filterText: null,
        sortText: "001",
        textEdit: null,
        additionalTextEdits: [],
        raw: { data: { fqn: "java.awt.List" } },
      },
      {
        label: "UtilList",
        kind: 7,
        detail: "java.util.List",
        documentation: null,
        insertText: null,
        insertTextFormat: null,
        filterText: null,
        sortText: "002",
        textEdit: null,
        additionalTextEdits: [],
        raw: { data: { fqn: "java.util.List" } },
      },
      {
        label: "ArrayBuffer",
        kind: 7,
        detail: "std.ArrayBuffer",
        documentation: null,
        insertText: null,
        insertTextFormat: null,
        filterText: null,
        sortText: "003",
        textEdit: null,
        additionalTextEdits: [],
        raw: { data: { fqn: "std.ArrayBuffer" } },
      },
    ];

    const controller = new LspCompletionController({
      sortMode: "alphabetical",
      excludedSymbols: [{ pattern: "java.awt.*", scope: "project" }],
      prioritizedSymbols: [{ pattern: "java.util.*", scope: "project" }],
    });

    const token: CompletionRequestIdentity = {
      workspaceId: "ws-1",
      fileKey: "k1",
      filePath: "/app.ts",
      uri: "file:///app.ts",
      languageId: "typescript",
      documentRevision: 1,
      lspSessionGeneration: 1,
    };

    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items,
    }));

    const source = createLspCompletionSource({
      identity: () => token,
      fetch,
      triggerCharacters: () => [],
      getDocumentRevision: () => 1,
      reportDiagnostic: vi.fn(),
      controller,
    });

    const state = EditorState.create({ doc: "" });
    const view = new EditorView({ state });
    const result = await source(new CompletionContext(state, 0, true));

    expect(result).not.toBeNull();
    const options = result!.options;
    // AwtList excluded!
    expect(options.some((o) => o.label === "AwtList")).toBe(false);
    // UtilList prioritized with boost and provenance detail!
    const utilOption = options.find((o) => o.label === "UtilList");
    expect(utilOption?.detail).toContain("(prioritized)");
    // Alphabetical sort: ArrayBuffer should precede UtilList!
    expect(options[0].label).toBe("ArrayBuffer");
    expect(options[1].label).toBe("UtilList");

    view.destroy();
  });

  it("autoInsertSingle executes single unambiguous candidate in 1 transaction without popup", async () => {
    const { EditorView } = await import("@codemirror/view");
    const singleItem = {
      label: "myUniqueFunction",
      kind: 3,
      detail: "void",
      documentation: null,
      insertText: "myUniqueFunction()",
      insertTextFormat: 1, // plain text, no choices
      filterText: null,
      sortText: "001",
      textEdit: null,
      additionalTextEdits: [],
      raw: {},
    };

    const controller = new LspCompletionController({
      autoInsertSingle: true,
    });

    const token: CompletionRequestIdentity = {
      workspaceId: "ws-1",
      fileKey: "k1",
      filePath: "/app.ts",
      uri: "file:///app.ts",
      languageId: "typescript",
      documentRevision: 1,
      lspSessionGeneration: 1,
    };

    let view: EditorView;
    const reportDiagnostic = vi.fn();
    const source = createLspCompletionSource({
      identity: () => token,
      fetch: async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [singleItem],
      }),
      triggerCharacters: () => [],
      getDocumentRevision: () => 1,
      reportDiagnostic,
      controller,
      getView: () => view,
    });

    const state = EditorState.create({ doc: "myUni" });
    view = new EditorView({ state });
    const outcome = await source(new CompletionContext(state, 5, true));

    // autoInsertSingle returns null because it directly committed the insertion
    expect(outcome).toBeNull();
    expect(reportDiagnostic).toHaveBeenCalledWith("auto-inserted-single");
    expect(view.state.doc.toString()).toBe("myUniqueFunction()");

    view.destroy();
  });

  it("blocks acceptance and reports diagnostic when resolve returns an excluded auto-import", async () => {
    const { EditorView } = await import("@codemirror/view");
    const itemToAccept = {
      label: "AmbiguousList",
      kind: 7,
      detail: "List",
      documentation: null,
      insertText: null,
      insertTextFormat: 1,
      filterText: null,
      sortText: "001",
      textEdit: null,
      additionalTextEdits: [],
      raw: {},
    };

    const controller = new LspCompletionController({
      excludedSymbols: [{ pattern: "java.awt.*", scope: "project" }],
    });

    const token: CompletionRequestIdentity = {
      workspaceId: "ws-1",
      fileKey: "k1",
      filePath: "/app.ts",
      uri: "file:///app.ts",
      languageId: "typescript",
      documentRevision: 1,
      lspSessionGeneration: 1,
    };

    const reportDiagnostic = vi.fn();
    const resolve = vi.fn(async () => ({
      ...itemToAccept,
      additionalTextEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "import java.awt.List;\n",
        },
      ],
    }));

    const source = createLspCompletionSource({
      identity: () => token,
      fetch: async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [itemToAccept],
      }),
      resolve,
      triggerCharacters: () => [],
      getDocumentRevision: () => 1,
      reportDiagnostic,
      controller,
    });

    const state = EditorState.create({ doc: "Amb" });
    const view = new EditorView({ state });
    const result = await source(new CompletionContext(state, 3, true));
    expect(result).not.toBeNull();
    const opt = result!.options[0];
    if (typeof opt.apply === "function") {
      opt.apply(view, opt, 0, 3);
    }
    await new Promise((r) => setTimeout(r, 50));

    expect(reportDiagnostic).toHaveBeenCalledWith("excluded-symbol-blocked", "auto-import-excluded");
    // Document must NOT have been written with the excluded import!
    expect(view.state.doc.toString()).toBe("Amb");

    view.destroy();
  });

  describe("§8.22.7 U2-E Live Completion Policy", () => {
    it("classifies candidate match tiers: exact > prefix > camelCase > fuzzy", () => {
      expect(matchCompletionQuery("testValue", "testValue").tier).toBe(1);
      expect(matchCompletionQuery("testValue", "TESTVALUE").tier).toBe(1);
      expect(matchCompletionQuery("testValue", "test").tier).toBe(2);
      expect(matchCompletionQuery("fileName", "fN").tier).toBe(3);
      expect(matchCompletionQuery("get_user_by_id", "gubi").tier).toBe(3);
      expect(matchCompletionQuery("findElementById", "feid").tier).toBe(4);
      expect(matchCompletionQuery("other", "xyz").tier).toBe(5);
    });

    it("sorts candidates according to IDEA heuristic ranking", () => {
      const optExact = { label: "item" };
      const optPrefix = { label: "itemValue" };
      const optCamel = { label: "insertTrailingEmptyMask" }; // camelCase initials "item"
      const optFuzzy = { label: "intermittent" }; // subsequence "i-t-e-m"
      const optOther = { label: "zebra" };

      const list = [optOther, optFuzzy, optCamel, optPrefix, optExact];
      list.sort((a, b) => compareCompletionCandidates(a, b, "item", "provider-relevance"));

      expect(list[0].label).toBe("item");
      expect(list[1].label).toBe("itemValue");
      expect(list[2].label).toBe("insertTrailingEmptyMask");
      expect(list[3].label).toBe("intermittent");
      expect(list[4].label).toBe("zebra");
    });

    it("WorkspaceCompletionPolicyController exposes unified configuration", () => {
      const controller = new WorkspaceCompletionPolicyController({
        minPrefixLength: 2,
        sortMode: "alphabetical",
      });

      expect(controller.shouldAutoTrigger(1, false)).toBe(false);
      expect(controller.shouldAutoTrigger(2, false)).toBe(true);
      expect(controller.getSortMode()).toBe("alphabetical");
    });

    it("§8.23.6 X5 WorkspaceCompletionPolicyController advances revision and notifies subscribers on update", () => {
      const controller = new WorkspaceCompletionPolicyController({
        minPrefixLength: 1,
      });

      expect(controller.getRevision()).toBe(1);
      const snap1 = controller.getSnapshot();
      expect(snap1.revision).toBe(1);
      expect(snap1.preferences.minPrefixLength).toBe(1);

      const receivedSnapshots: any[] = [];
      const unsub = controller.subscribe((snap) => {
        receivedSnapshots.push(snap);
      });

      const snap2 = controller.update({ minPrefixLength: 3, maxItems: 100 });
      expect(snap2.revision).toBe(2);
      expect(snap2.preferences.minPrefixLength).toBe(3);
      expect(snap2.preferences.maxItems).toBe(100);
      expect(receivedSnapshots).toHaveLength(1);
      expect(receivedSnapshots[0].revision).toBe(2);

      unsub();
      controller.update({ minPrefixLength: 4 });
      expect(controller.getRevision()).toBe(3);
      expect(receivedSnapshots).toHaveLength(1); // No new events after unsub
    });
  });
}
