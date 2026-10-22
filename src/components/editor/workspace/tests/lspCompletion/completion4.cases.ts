import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import type { LspCompletionResult } from "../../../../../lib/editor/lsp";
import { createFixtureCompletionSource, createLspCompletionSource, MAX_COMPLETION_OPTIONS } from "../../lspCompletion";
import { completionResult, contextAt, status } from "./harness";

export function registerlspCompletionCompletion4Cases() {
  it("skips silently when there is nothing to complete", async () => {
    const fetch = vi.fn();
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => ["."] });

    expect(await source(contextAt("const x = 1;\n", 0))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("queries on word prefixes and reports LSP options", async () => {
    const fetch = vi.fn(async () => completionResult(["openFile", "openDir"]));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });

    const result = await source(contextAt("op", 2));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 2 }, null);
    expect(result?.from).toBe(0);
    expect(result?.options.map((option) => option.label)).toEqual(["openFile", "openDir"]);
    expect(result?.options[0].type).toBe("function");
  });

  it("fires on trigger characters without a word prefix", async () => {
    const fetch = vi.fn(async () => completionResult(["toString"]));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => ["."] });

    const result = await source(contextAt("value.", 6));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 6 }, ".");
    expect(result?.from).toBe(6);
  });

  it("falls back to buffer words when the language service is inactive", async () => {
    const fetch = vi.fn(async () => completionResult([], false));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });

    const result = await source(contextAt("workspace wor", 13));

    expect(result?.options.some((option) => option.label === "workspace")).toBe(true);
  });

  it("ED-PARITY-020: offers no buffer words at a member access when the service is inactive", async () => {
    const fetch = vi.fn(async () => completionResult([], false));
    const onProviderUnavailable = vi.fn();
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [], onProviderUnavailable });

    const result = await source(contextAt("calculator calculator.ca", 24));

    expect(result).toBeNull();
    expect(onProviderUnavailable).toHaveBeenCalledWith({ explicit: false });
    // Outside a member access the word fallback stays.
    const plain = await source(contextAt("workspace wor", 13));
    expect(plain?.options.some((option) => option.label === "workspace")).toBe(true);
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
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
    const result = await source(contextAt("to", 2));
    expect(result?.options[0]?.label).toBe("toString");
    expect(result?.options[0]?.displayLabel).toBe("toString(): string");
    expect(result?.options[0]?.sortText).toBe("0001");
    expect(result?.options[0]?.boost).toBeGreaterThan(0);
  });

  it("shows a qualified Java type name and package once", async () => {
    const raw = { label: "StringUtils - org.apache.commons.lang3", data: { pid: "1", rid: "2" } };
    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: raw.label,
        kind: 7,
        detail: "org.apache.commons.lang3.StringUtils",
        documentation: null,
        insertText: "StringUtils",
        insertTextFormat: 2,
        filterText: "StringUtils",
        sortText: "999998892",
        textEdit: null,
        additionalTextEdits: [],
        raw,
      }],
    }));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
    const result = await source(contextAt("StringUti", 9, true));
    expect(result?.options[0]).toMatchObject({
      label: "StringUtils",
      detail: "org.apache.commons.lang3",
    });
    expect(result?.options[0]?.displayLabel).toBeUndefined();
  });

  it("shows a Java method signature and return type without repeated provider detail", async () => {
    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: "append(String str) : StringBuilder",
        kind: 2,
        detail: "StringBuilder.append(String str) : StringBuilder",
        documentation: null,
        insertText: "append",
        insertTextFormat: 2,
        filterText: "append(${1:null})",
        sortText: "999999035",
        textEdit: null,
        additionalTextEdits: [],
        raw: { label: "append(String str) : StringBuilder" },
      }],
    }));
    const source = createLspCompletionSource({
      identity: () => ({
        workspaceId: "parity005", fileKey: "Main.java", filePath: "/Main.java",
        uri: "file:///Main.java", languageId: "java", documentRevision: 0,
        lspSessionGeneration: 1,
      }),
      fetch,
      triggerCharacters: () => [],
      getDocumentRevision: () => 0,
      reportDiagnostic: vi.fn(),
    });
    const result = await source(contextAt("appen", 5, true));
    expect(result?.options[0]).toMatchObject({
      label: "append(${1:null})",
      displayLabel: "append(String str)",
      detail: "StringBuilder",
    });
  });

  it("passes the member-access trigger when typing after a trigger character", async () => {
    const fetch = vi.fn(async () => completionResult(["toString"]));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => ["."] });

    await source(contextAt("value.to", 8));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 8 }, ".");
  });

  it("sends no trigger character for an explicit invocation at a space-prefixed identifier", async () => {
    // jdtls registers ` ` in its trigger-character set but answers a
    // space-triggered word request with an empty list, so an explicit
    // Ctrl+Space at `StringUti` must go out as triggerKind 1 (no trigger
    // character) or the popup shows only templates.
    const fetch = vi.fn(async () =>
      completionResult(["StringUtils - org.apache.commons.lang3"]));
    const source = createFixtureCompletionSource({
      fetch,
      triggerCharacters: () => [" ", ".", "@", "#", "*"],
    });

    await source(contextAt("            StringUti", 21, true));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 21 }, null);
  });

  it("treats typing an identifier after whitespace as Invoked, not space-triggered", async () => {
    const fetch = vi.fn(async () => completionResult(["StringBuilder"]));
    const source = createFixtureCompletionSource({
      fetch,
      triggerCharacters: () => [" ", "."],
    });

    await source(contextAt("    Stri", 8));

    expect(fetch).toHaveBeenCalledWith({ line: 0, character: 8 }, null);
  }, 2000);

  it("caps very large completion lists for popup performance", async () => {
    const labels = Array.from({ length: MAX_COMPLETION_OPTIONS + 50 }, (_, i) => `item${i}`);
    const fetch = vi.fn(async () => completionResult(labels));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
    const result = await source(contextAt("it", 2));
    expect(result?.options).toHaveLength(MAX_COMPLETION_OPTIONS);
  });

  it("aborts early during fast typing without issuing fetch", async () => {
    const fetch = vi.fn(async () => completionResult(["item"]));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
    const context = contextAt("it", 2);
    const promise = source(context);
    // Simulate another keystroke arriving immediately (aborting previous context)
    const raw = context as unknown as { abortListeners?: Array<() => void>; };
    Object.defineProperty(context, "aborted", { value: true, configurable: true });
    raw.abortListeners?.forEach((l) => l());
    const result = await promise;
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("suppresses word-based LSP autocompletion inside string literals", async () => {
    const fetch = vi.fn(async () => completionResult(["another"]));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => ["."] });
    const doc = 'String firstStr = "this is another";';
    const pos = doc.indexOf("another") + 2;
    const result = await source(contextAt(doc, pos));
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never returns hardcoded Java JDK completions when language service is inactive", async () => {
    const fetch = vi.fn(async () => completionResult([], false));
    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });

    const result = await source(contextAt("Lis", 3));
    // Should fall back to completeAnyWord, without synthetic JDK imports like java.util.List
    const labels = result?.options.map((opt) => opt.label) ?? [];
    expect(labels).not.toContain("ArrayList");
    expect(labels).not.toContain("HashMap");
  });

  it("applies primary textEdit and additionalTextEdits in a single atomic dispatch", async () => {
    const { EditorView } = await import("@codemirror/view");
    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: "List",
        kind: 7,
        detail: "java.util.List",
        documentation: null,
        insertText: "List",
        insertTextFormat: 1,
        filterText: "List",
        sortText: "0001",
        textEdit: {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          newText: "List",
        },
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "import java.util.List;\n",
        }],
        raw: {},
      }],
    }));

    const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
    const initialText = "\nLis";
    const state = EditorState.create({ doc: initialText });
    const view = new EditorView({ state });

    const result = await source(new CompletionContext(state, 4, true));
    expect(result?.options).toHaveLength(1);

    const option = result!.options[0];
    const dispatchSpy = vi.spyOn(view, "dispatch");

    if (typeof option.apply === "function") {
      option.apply(view, option, 1, 4);
    }

    // Assert single atomic dispatch
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("import java.util.List;\n\nList");
  });

  it("guards against stale async resolve when document changes before resolve completes", async () => {
    const { EditorView } = await import("@codemirror/view");
    let resolvePromise: (item: any) => void = () => { };
    const deferredResolve = new Promise<any>((r) => { resolvePromise = r; });

    const fetch = vi.fn(async (): Promise<LspCompletionResult> => ({
      status: status(true),
      isIncomplete: false,
      items: [{
        label: "AutoImportedClass",
        kind: 7,
        detail: null,
        documentation: null,
        insertText: "AutoImportedClass",
        insertTextFormat: 1,
        filterText: "AutoImportedClass",
        sortText: "0001",
        textEdit: null,
        additionalTextEdits: [],
        raw: {},
      }],
    }));

    const resolve = vi.fn(() => deferredResolve);
    let docRevision = 1;
    const source = createFixtureCompletionSource({
      fetch,
      resolve,
      triggerCharacters: () => [],
      getDocumentRevision: () => docRevision,
    });

    const initialText = "const a = Aut";
    const state = EditorState.create({ doc: initialText });
    const view = new EditorView({ state });

    const result = await source(new CompletionContext(state, 13, true));
    const option = result!.options[0];

    // User accepts completion
    if (typeof option.apply === "function") {
      option.apply(view, option, 10, 13);
    }
    // Acceptance waits for resolve so primary + auto-import can commit once.
    expect(view.state.doc.toString()).toBe("const a = Aut");

    // Before resolve arrives, user types further, bumping documentRevision
    docRevision = 2;
    view.dispatch({ changes: { from: 13, to: 13, insert: ";" } });

    // Now resolve arrives with additionalTextEdits
    resolvePromise({
      additionalTextEdits: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import { AutoImportedClass } from './module';\n",
      }],
    });
    await deferredResolve;
    await new Promise((r) => setTimeout(r, 10));

    // Stale additionalTextEdits should NOT be applied to mutated revision
    expect(view.state.doc.toString()).toBe("const a = Aut;");
  });
}
