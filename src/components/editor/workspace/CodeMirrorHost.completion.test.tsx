import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { LspCompletionItem } from "../../../lib/editor/lsp";
import { CodeMirrorHost } from "./CodeMirrorHost";

describe("CodeMirrorHost LSP completion acceptance", () => {
  afterEach(cleanup);

  it.each(["Tab", "Enter", "mouse"])("accepts with %s after refining an open Java completion list", async (acceptWith) => {
    let revision = 0;
    const diagnostic = vi.fn();
    const complete = vi.fn(async (position: { line: number; character: number }) => ({
      status: {
        path: "App.java", uri: "file:///App.java", presetId: "java", languageId: "java",
        displayName: "Java", available: true, active: true, selectedCommandId: null,
        selectedCommand: null, installHint: null, error: null,
      },
      isIncomplete: false,
      items: ["print", "println"].map((label): LspCompletionItem => ({
        label, kind: 2, detail: null, documentation: null, insertText: label,
        insertTextFormat: 1, filterText: null, sortText: label,
        textEdit: {
          range: { start: { line: 0, character: 11 }, end: position },
          newText: `${label}()`,
        },
        additionalTextEdits: [], raw: { label, position },
      })),
    }));
    const resolve = vi.fn(async (raw: unknown) => {
      const { label, position } = raw as { label: string; position: { line: number; character: number } };
      return (await complete(position)).items.find((item) => item.label === label)!;
    });
    const rendered = render(<CodeMirrorHost
      path="App.java"
      doc="System.out.p"
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
      completionTriggers={["."]}
      hoverDocumentationDelayMs={0}
      getCompletionIdentity={() => ({
        workspaceId: "workspace", fileKey: "App.java", filePath: "App.java",
        uri: "file:///App.java", languageId: "java", documentRevision: revision,
        lspSessionGeneration: 1,
      })}
      onCompletionDiagnostic={diagnostic}
    />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(content).toHaveAttribute("data-language", "java"));
    act(() => {
      view.focus();
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "r" },
        selection: { anchor: view.state.doc.length + 1 },
        userEvent: "input.type",
      });
    });
    await waitFor(() => expect(document.querySelectorAll(".cm-tooltip-autocomplete li")).toHaveLength(2));

    // Provider edits and resolve data belong to the prefix's document version.
    act(() => view.dispatch({
      changes: { from: view.state.doc.length, insert: "i" },
      selection: { anchor: view.state.doc.length + 1 },
      userEvent: "input.type",
    }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith(
      { line: 0, character: 14 }, expect.anything(), expect.anything(), expect.anything(),
    ));
    await waitFor(() => expect(document.querySelectorAll(".cm-tooltip-autocomplete li")).toHaveLength(2));
    fireEvent.keyDown(content, { key: "ArrowDown" });
    expect(document.querySelector('.cm-tooltip-autocomplete [aria-selected="true"]')).toHaveTextContent("println");
    fireEvent.keyDown(content, { key: "ArrowUp" });
    expect(document.querySelector('.cm-tooltip-autocomplete [aria-selected="true"]')).toHaveTextContent("print");

    if (acceptWith === "mouse") {
      fireEvent.mouseDown(document.querySelectorAll(".cm-tooltip-autocomplete li")[1], { button: 0 });
    } else {
      fireEvent.keyDown(content, { key: "ArrowDown" });
      fireEvent.keyDown(content, { key: acceptWith });
    }
    await waitFor(() => expect(view.state.doc.toString()).toBe("System.out.println()"));
    expect(diagnostic).not.toHaveBeenCalled();
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe("System.out.pri");
  });

  it("yields app live templates to provider snippet templates with the same Java label", async () => {
    let revision = 0;
    const providerSoutm: LspCompletionItem = {
      label: "soutm",
      kind: 15,
      detail: "print current method to standard out",
      documentation: null,
      insertText: 'System.out.println("App.main()");',
      insertTextFormat: 2,
      filterText: null,
      sortText: "999999999",
      textEdit: null,
      additionalTextEdits: [],
      raw: { label: "soutm" },
    };
    const complete = vi.fn(async () => ({
      status: {
        path: "App.java", uri: "file:///App.java", presetId: "java", languageId: "java",
        displayName: "Java", available: true, active: true, selectedCommandId: null,
        selectedCommand: null, installHint: null, error: null,
      },
      isIncomplete: false,
      items: [providerSoutm],
    }));
    const rendered = render(<CodeMirrorHost
      path="App.java"
      doc="soutm"
      visible
      diagnostics={[]}
      reveal={null}
      onChange={() => { revision += 1; }}
      onSave={vi.fn()}
      onHover={async () => null}
      onDefinition={async () => false}
      onReferences={async () => undefined}
      onComplete={complete}
      onCompleteResolve={async () => providerSoutm}
      completionTriggers={["."]}
      hoverDocumentationDelayMs={0}
      getCompletionIdentity={() => ({
        workspaceId: "workspace", fileKey: "App.java", filePath: "App.java",
        uri: "file:///App.java", languageId: "java", documentRevision: revision,
        lspSessionGeneration: 1,
      })}
      onCompletionDiagnostic={vi.fn()}
    />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(content).toHaveAttribute("data-language", "java"));
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      startCompletion(view);
    });
    // The app's live-template entry opens the popup first...
    await waitFor(() => {
      const popup = document.querySelector(".cm-tooltip-autocomplete");
      expect(popup?.textContent ?? "").toContain("Prints current method name to System.out");
    });
    // ...and once the provider snippet arrives, its exact `soutm` label owns
    // the abbreviation and the app's placeholder entry disappears.
    await waitFor(() => {
      const popup = document.querySelector(".cm-tooltip-autocomplete");
      expect(popup?.textContent ?? "").toContain("print current method to standard out");
      expect(popup?.textContent ?? "").not.toContain("Prints current method name to System.out");
    });
    // Tab with the popup dismissed routes to provider completion instead of
    // expanding the app template or inserting indentation.
    fireEvent.keyDown(content, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull());
    fireEvent.keyDown(content, { key: "Tab" });
    await waitFor(() => {
      const popup = document.querySelector(".cm-tooltip-autocomplete");
      expect(popup?.textContent ?? "").toContain("print current method to standard out");
    });
    expect(view.state.doc.toString()).toBe("soutm");
    // Accept the provider template.
    fireEvent.keyDown(content, { key: "Tab" });
    await waitFor(() => expect(view.state.doc.toString()).toBe('System.out.println("App.main()");'));
  });
});
