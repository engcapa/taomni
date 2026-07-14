import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import type { LspCompletionResult, LspDocumentStatus } from "../../../lib/editor/lsp";
import {
  completionKindToType,
  createLspCompletionSource,
  lspSnippetToCmSnippet,
} from "./lspCompletion";

function status(active: boolean): LspDocumentStatus {
  return {
    path: "a.ts",
    uri: "file:///a.ts",
    presetId: "typescript-javascript",
    languageId: "typescript",
    displayName: "TypeScript",
    available: true,
    active,
    selectedCommandId: null,
    selectedCommand: null,
    installHint: null,
    error: null,
  };
}

function completionResult(labels: string[], active = true): LspCompletionResult {
  return {
    status: status(active),
    isIncomplete: false,
    items: labels.map((label) => ({
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
    })),
  };
}

function contextAt(docText: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc: docText });
  return new CompletionContext(state, pos, explicit);
}

describe("lspSnippetToCmSnippet", () => {
  it("converts tabstops, placeholders, and choices", () => {
    expect(lspSnippetToCmSnippet("openFile($1)$0")).toBe("openFile(${})${}");
    expect(lspSnippetToCmSnippet("for (const ${1:item} of ${2:items}) {}"))
      .toBe("for (const ${item} of ${items}) {}");
    expect(lspSnippetToCmSnippet("align: ${1|left,right,center|}")).toBe("align: ${left}");
    expect(lspSnippetToCmSnippet("${1}")).toBe("${}");
  });

  it("keeps escaped dollars literal and protects would-be fields", () => {
    // Unescaped $<digit> is a tabstop per the LSP spec; literals need \$.
    expect(lspSnippetToCmSnippet("price: \\$5")).toBe("price: $5");
    expect(lspSnippetToCmSnippet("\\$1 stays")).toBe("$1 stays");
    expect(lspSnippetToCmSnippet("template \\${literal}")).toBe("template \\${literal}");
    expect(lspSnippetToCmSnippet("plain $ dollar")).toBe("plain $ dollar");
  });
});

describe("completionKindToType", () => {
  it("maps LSP kinds to CodeMirror types", () => {
    expect(completionKindToType(2)).toBe("method");
    expect(completionKindToType(7)).toBe("class");
    expect(completionKindToType(14)).toBe("keyword");
    expect(completionKindToType(null)).toBeUndefined();
    expect(completionKindToType(99)).toBe("text");
  });
});

describe("createLspCompletionSource", () => {
  it("skips silently when there is nothing to complete", async () => {
    const fetch = vi.fn();
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => ["."] });

    expect(await source(contextAt("const x = 1;\n", 0))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("queries on word prefixes and reports LSP options", async () => {
    const fetch = vi.fn(async () => completionResult(["openFile", "openDir"]));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });

    const result = await source(contextAt("op", 2));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 2 }, null);
    expect(result?.from).toBe(0);
    expect(result?.options.map((option) => option.label)).toEqual(["openFile", "openDir"]);
    expect(result?.options[0].type).toBe("function");
  });

  it("fires on trigger characters without a word prefix", async () => {
    const fetch = vi.fn(async () => completionResult(["toString"]));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => ["."] });

    const result = await source(contextAt("value.", 6));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 6 }, ".");
    expect(result?.from).toBe(6);
  });

  it("falls back to buffer words when the language service is inactive", async () => {
    const fetch = vi.fn(async () => completionResult([], false));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });

    const result = await source(contextAt("workspace wor", 13));

    expect(result?.options.some((option) => option.label === "workspace")).toBe(true);
  });

  it("uses filterText for matching and sortText for ordering metadata", async () => {
    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: "toString(): string",
        kind: 2,
        detail: null,
        documentation: null,
        insertText: "toString",
        insertTextFormat: 1,
        filterText: "toString",
        sortText: "0001",
        textEdit: null,
        additionalTextEdits: [],
        raw: {},
      }],
    }));
    const source = createLspCompletionSource({ fetch, triggerCharacters: () => [] });
    const result = await source(contextAt("to", 2));
    expect(result?.options[0]?.label).toBe("toString");
    expect(result?.options[0]?.displayLabel).toBe("toString(): string");
    expect(result?.options[0]?.sortText).toBe("0001");
  });
});
