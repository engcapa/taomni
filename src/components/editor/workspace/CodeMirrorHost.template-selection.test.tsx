import { selectedCompletion, startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspCompletionItem, LspCompletionResult } from "../../../lib/editor/lsp";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { LspCompletionController } from "./lspCompletion";

describe("Live template selection while the provider finishes", () => {
  afterEach(cleanup);

  it("keeps the selected abbreviation when late provider templates replace local candidates", async () => {
    let resolveProvider!: (result: LspCompletionResult) => void;
    const pending = new Promise<LspCompletionResult>((resolve) => { resolveProvider = resolve; });
    const complete = vi.fn(() => pending);
    const items: LspCompletionItem[] = ["sout", "soutm"].map((label, index) => ({
      label,
      kind: 15,
      detail: `provider ${label}`,
      documentation: null,
      insertText: index ? 'System.out.println("App.main()");' : "System.out.println();",
      insertTextFormat: 2,
      filterText: null,
      sortText: String(index),
      textEdit: null,
      additionalTextEdits: [],
      raw: { label },
    }));
    const resolve = vi.fn(async (raw: unknown) => items.find((item) => item.label === (raw as { label: string }).label)!);
    const original = "class App {\n  sout\n}";
    let revision = 0;
    const rendered = render(<CodeMirrorHost
      path="App.java"
      doc={original}
      visible
      diagnostics={[]}
      reveal={null}
      onChange={() => { revision += 1; }}
      onSave={vi.fn()}
      onHover={async () => null}
      onDefinition={async () => false}
      onReferences={async () => undefined}
      onComplete={complete}
      onCompleteResolve={resolve}
      onCompletionDiagnostic={vi.fn()}
      completionController={new LspCompletionController({ showDocumentation: false })}
      getCompletionIdentity={() => ({
        workspaceId: "workspace", fileKey: "App.java", filePath: "App.java",
        uri: "file:///App.java", languageId: "java", documentRevision: revision,
        lspSessionGeneration: 1,
      })}
    />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(content).toHaveAttribute("data-language", "java"));
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 18 } });
      startCompletion(view);
    });
    await waitFor(() => expect(selectedCompletion(view.state)?.label).toBe("sout"));
    await act(async () => { await new Promise((resolveDelay) => setTimeout(resolveDelay, 100)); });
    fireEvent.keyDown(content, { key: "ArrowDown" });
    expect(selectedCompletion(view.state)?.label).toBe("soutm");

    await act(async () => {
      resolveProvider({
        status: {
          path: "App.java", uri: "file:///App.java", presetId: "java", languageId: "java",
          displayName: "Java", available: true, active: true, selectedCommandId: null,
          selectedCommand: null, installHint: null, error: null,
        },
        isIncomplete: false,
        items,
      });
    });
    await waitFor(() => expect(document.querySelectorAll(".cm-lsp-provider-option")).toHaveLength(2));
    await waitFor(() => expect(document.querySelectorAll(".cm-completionLabel")).toHaveLength(4));
    expect(selectedCompletion(view.state)?.label).toBe("soutm");
    fireEvent.keyDown(content, { key: "Enter" });
    await waitFor(() => expect(view.state.doc.toString()).toBe('class App {\n  System.out.println("App.main()");\n}'));
    expect(resolve).toHaveBeenCalledWith({ label: "soutm" }, expect.anything());
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe(original);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
