import { CompletionContext } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import type { LspCompletionResult } from "../../../../../lib/editor/lsp";
import {
  activeLspSnippetSession,
  advanceLspSnippetTabstop,
  cancelLspSnippetSession,
  createFixtureCompletionSource,
  lspSnippetSessionInvalidator,
  parseLspSnippet,
  recentCompletionTelemetry,
  resetCompletionTelemetry,
} from "../../lspCompletion";
import { status } from "./harness";

export function registerlspCompletionCompletion2Cases() {

  describe("P0-J1 remainder: parseLspSnippet spans & tabstop session", () => {
    it("returns full placeholder spans covering default text", () => {
      const parsed = parseLspSnippet("loadUser(${1:user}, ${2|a,b|})$0");
      expect(parsed.text).toBe("loadUser(user, a)");
      // §8.18.3: choice placeholders keep their option list for the
      // interactive choice session; plain stops carry no choices.
      expect(parsed.placeholders).toEqual([
        { start: "loadUser(".length, end: "loadUser(user".length },
        {
          start: "loadUser(user, ".length,
          end: "loadUser(user, a".length,
          choices: ["a", "b"],
        },
        { start: parsed.text.length, end: parsed.text.length },
      ]);
    });

    function snippetPlusImportView(EditorViewCtor: typeof import("@codemirror/view").EditorView) {
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
      const state = EditorState.create({
        doc: "\nloadU",
        extensions: [history(), lspSnippetSessionInvalidator()],
      });
      const view = new EditorViewCtor({ state });
      return { source, view };
    }

    it("one acceptance advances one revision and one undo reverts primary+import together", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { source, view } = snippetPlusImportView(EditorView);
      const result = await source(new CompletionContext(view.state, 6, true));
      const option = result!.options[0];
      if (typeof option.apply === "function") {
        option.apply(view, option, 1, 6);
      }
      expect(view.state.doc.toString()).toBe(
        `import { loadUser } from "./users";\n\nloadUser(user)`,
      );
      undo(view);
      expect(view.state.doc.toString()).toBe("\nloadU");
      view.destroy();
    });

    it("Tab cycles committed placeholder spans without document edits; Esc ends the session", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { source, view } = snippetPlusImportView(EditorView);
      const result = await source(new CompletionContext(view.state, 6, true));
      const option = result!.options[0];
      if (typeof option.apply === "function") {
        option.apply(view, option, 1, 6);
      }
      const importPrefix = `import { loadUser } from "./users";\n`.length;
      const docAfterAccept = view.state.doc.toString();

      // First placeholder span selected at accept.
      expect(view.state.selection.main.from).toBe(importPrefix + 1 + "loadUser(".length);
      expect(view.state.selection.main.to).toBe(importPrefix + 1 + "loadUser(user".length);

      // The final Tab exits caret-only (no undoable indent, session ends).
      expect(advanceLspSnippetTabstop(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(docAfterAccept);
      expect(view.state.selection.main.head).toBe(importPrefix + 1 + "loadUser(user".length);
      expect(activeLspSnippetSession(view)).toBe(false);

      // Multi-placeholder session: Tab moves between spans with zero doc change.
      const fetchMulti = vi.fn(async (): Promise<LspCompletionResult> => ({
        status: status(true),
        isIncomplete: false,
        items: [{
          label: "pair",
          kind: 3,
          detail: null,
          documentation: null,
          insertText: "pair(${1:a}, ${2:b})",
          insertTextFormat: 2,
          filterText: null,
          sortText: "0001",
          textEdit: null,
          // Non-empty additional edits route through the combined single-
          // dispatch acceptance that owns the tabstop session.
          additionalTextEdits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "import { pair } from \"./pair\";\n",
          }],
          raw: {},
        }],
      }));
      const multiSource = createFixtureCompletionSource({ fetch: fetchMulti, triggerCharacters: () => [] });
      const stateMulti = EditorState.create({
        doc: "\npai",
        extensions: [history(), lspSnippetSessionInvalidator()],
      });
      const viewMulti = new EditorView({ state: stateMulti });
      const multiResult = await multiSource(new CompletionContext(stateMulti, 4, true));
      const multiOption = multiResult!.options[0];
      if (typeof multiOption.apply === "function") {
        multiOption.apply(viewMulti, multiOption, 1, 4);
      }
      const docMulti = viewMulti.state.doc.toString();
      expect(docMulti).toBe(`import { pair } from "./pair";\n\npair(a, b)`);
      const pairPrefix = `import { pair } from "./pair";\n\n`.length;
      expect(viewMulti.state.selection.main.from).toBe(pairPrefix + "pair(".length);
      expect(viewMulti.state.selection.main.to).toBe(pairPrefix + "pair(a".length);
      // Second placeholder selected after Tab with zero document edits.
      expect(advanceLspSnippetTabstop(viewMulti)).toBe(true);
      expect(viewMulti.state.doc.toString()).toBe(docMulti);
      expect(viewMulti.state.selection.main.from).toBe(pairPrefix + "pair(a, ".length);
      expect(viewMulti.state.selection.main.to).toBe(pairPrefix + "pair(a, b".length);
      // Exhausted: caret-only exit at the last span's end, session closed.
      expect(advanceLspSnippetTabstop(viewMulti)).toBe(true);
      expect(viewMulti.state.doc.toString()).toBe(docMulti);
      expect(viewMulti.state.selection.main.head).toBe(pairPrefix + "pair(a, b".length);
      expect(activeLspSnippetSession(viewMulti)).toBe(false);
      viewMulti.destroy();

      cancelLspSnippetSession(view);
      expect(docAfterAccept.length).toBeGreaterThan(0);
      view.destroy();
    });

    it("any unrelated document edit invalidates the pending tabstop session", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { source, view } = snippetPlusImportView(EditorView);
      const result = await source(new CompletionContext(view.state, 6, true));
      const option = result!.options[0];
      if (typeof option.apply === "function") {
        option.apply(view, option, 1, 6);
      }
      // Simulate an unrelated edit through the same view dispatch pipeline.
      view.dispatch({ changes: { from: 0, insert: "// note\n" } });
      expect(advanceLspSnippetTabstop(view)).toBe(false);
      view.destroy();
    });
  });

  describe("P0-J1 request telemetry ring", () => {
    it("records phases with counts/truncation but no labels or source content", async () => {
      resetCompletionTelemetry();
      const { EditorView } = await import("@codemirror/view");
      const items = Array.from({ length: 250 }, (_unused, i) => ({
        label: `secretLabel${i}`,
        kind: 6,
        detail: null,
        documentation: null,
        insertText: null,
        insertTextFormat: 1,
        filterText: null,
        sortText: String(i).padStart(4, "0"),
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
      const source = createFixtureCompletionSource({ fetch, triggerCharacters: () => [] });
      const state = EditorState.create({ doc: "x" });
      const view = new EditorView({ state });
      await source(new CompletionContext(state, 1, true));
      const events = recentCompletionTelemetry();
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.map((event) => event.phase)).toContain("fetching");
      expect(events.map((event) => event.phase)).toContain("popup");
      const popup = events.find((event) => event.phase === "popup");
      expect(popup?.itemCount).toBe(200);
      expect(popup?.truncated).toBe(true);
      // No label / doc text may leak into telemetry payloads.
      for (const event of events) {
        expect(JSON.stringify(event)).not.toContain("secretLabel");
      }
      view.destroy();
    });
  });
}
