import { closeCompletion, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LspCompletionItem } from "../../../../../lib/editor/lsp";
import { CodeMirrorHost } from "../../CodeMirrorHost";
import { WorkspaceDocumentTransactionOwner } from "../../workspaceDocumentTransactionOwner";

export function registerCodeMirrorHostlivetemplateinteractionCompletion4Cases() {

  it("AC-05 / RT-11: same labels at a second caret range must still deduplicate local templates", async () => {
    let revision = 0;
    const doc = "class App {\n void first() { soutm }\n void second() { soutm }\n}";
    const providerSoutm: LspCompletionItem = {
      label: "soutm",
      kind: 15,
      detail: "PROVIDER current method",
      documentation: null,
      insertText: 'System.out.println("ACTUAL_METHOD");',
      insertTextFormat: 2,
      filterText: null,
      sortText: "0",
      textEdit: null,
      additionalTextEdits: [],
      raw: { label: "soutm" },
    };

    const complete = vi.fn(async () => ({
      status: {
        path: "App.java",
        uri: "file:///App.java",
        presetId: "java",
        languageId: "java",
        displayName: "Java",
        available: true,
        active: true,
        selectedCommandId: null,
        selectedCommand: null,
        installHint: null,
        error: null,
      },
      isIncomplete: false,
      items: [providerSoutm],
    }));

    const rendered = render(
      <CodeMirrorHost
        path="App.java"
        doc={doc}
        visible
        diagnostics={[]}
        reveal={null}
        onChange={() => { revision++; }}
        onSave={vi.fn()}
        onHover={async () => null}
        onDefinition={async () => false}
        onReferences={async () => undefined}
        onComplete={complete}
        onCompleteResolve={async () => providerSoutm}
        completionTriggers={["."]}
        hoverDocumentationDelayMs={0}
        onCompletionDiagnostic={vi.fn()}
        getCompletionIdentity={() => ({
          workspaceId: "workspace",
          fileKey: "App.java",
          filePath: "App.java",
          uri: "file:///App.java",
          languageId: "java",
          documentRevision: revision,
          lspSessionGeneration: 1,
        })}
      />,
    );

    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(content).toHaveAttribute("data-language", "java"));

    const openAt = async (pos: number) => {
      act(() => {
        view.focus();
        view.dispatch({ selection: { anchor: pos } });
        startCompletion(view);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450));
      });
    };

    // First location
    await openAt(doc.indexOf("soutm") + 5);
    const firstCompletions = currentCompletions(view.state)
      .filter((c) => c.label === "soutm")
      .map((c) => c.detail);
    expect(firstCompletions).toEqual(["PROVIDER current method"]);

    act(() => {
      closeCompletion(view);
    });

    // Second location (different range in same document without doc change)
    await openAt(doc.lastIndexOf("soutm") + 5);
    const secondCompletions = currentCompletions(view.state)
      .filter((c) => c.label === "soutm")
      .map((c) => c.detail);

    // Second range must ALSO deduplicate local template and only show provider template
    expect(secondCompletions).toEqual(["PROVIDER current method"]);

    // Enter accepts at second location
    fireEvent.keyDown(content, { key: "Enter" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(view.state.doc.toString()).toContain('void second() { System.out.println("ACTUAL_METHOD"); }');
  });

  it("AC-03 / RT-22: normal LSP members (non-snippets) do not claim live templates", async () => {
    let revision = 0;
    const normalMember: LspCompletionItem = {
      label: "sout",
      kind: 2, // Method, NOT snippet (15)
      detail: "void sout()",
      documentation: null,
      insertText: "sout()",
      insertTextFormat: 1,
      filterText: null,
      sortText: "0",
      textEdit: null,
      additionalTextEdits: [],
      raw: { label: "sout" },
    };

    const complete = vi.fn(async () => ({
      status: {
        path: "App.java",
        uri: "file:///App.java",
        presetId: "java",
        languageId: "java",
        displayName: "Java",
        available: true,
        active: true,
        selectedCommandId: null,
        selectedCommand: null,
        installHint: null,
        error: null,
      },
      isIncomplete: false,
      items: [normalMember],
    }));

    const rendered = render(
      <CodeMirrorHost
        path="App.java"
        doc={"class App {\n  sout\n}"}
        visible
        diagnostics={[]}
        reveal={null}
        onChange={() => { revision++; }}
        onSave={vi.fn()}
        onHover={async () => null}
        onDefinition={async () => false}
        onReferences={async () => undefined}
        onComplete={complete}
        onCompleteResolve={async () => normalMember}
        completionTriggers={["."]}
        hoverDocumentationDelayMs={0}
        onCompletionDiagnostic={vi.fn()}
        getCompletionIdentity={() => ({
          workspaceId: "workspace",
          fileKey: "App.java",
          filePath: "App.java",
          uri: "file:///App.java",
          languageId: "java",
          documentRevision: revision,
          lspSessionGeneration: 1,
        })}
      />,
    );

    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(content).toHaveAttribute("data-language", "java"));

    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 18 } });
      startCompletion(view);
    });

    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete li")).not.toBeNull());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    // Dismiss popup
    fireEvent.keyDown(content, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull());

    // Single Tab on exact sout: since normal member is not a snippet, it does NOT claim sout!
    // Local sout live template expands!
    fireEvent.keyDown(content, { key: "Tab" });
    await waitFor(() => {
      expect(view.state.doc.toString()).toContain("System.out.println();");
    });
  });

  it("AC-07 / RT-20 / R5: readOnly editor must still accept external controlled document snapshots", async () => {
    const props = {
      path: "App.java", doc: "class Before {}", visible: true, readOnly: true,
      diagnostics: [], reveal: null, onChange: vi.fn(), onSave: vi.fn(),
      onHover: vi.fn(async () => null), onDefinition: vi.fn(async () => false),
      onReferences: vi.fn(async () => undefined), getCompletionIdentity: () => null,
      onCompletionDiagnostic: vi.fn(),
    };
    const r = render(<CodeMirrorHost {...props} />);
    const content = r.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    r.rerender(<CodeMirrorHost {...props} doc="class After {}" documentRevision={1} />);
    await waitFor(() => expect(view.state.doc.toString()).toBe("class After {}"));
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("AC-07 / RT-20 / R5: readOnly view must follow shared owner and keep the synchronized text after unlocking", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const props = {
      path: "App.java", fileKey: "App.java", viewId: "readonly-view", transactionOwner: owner,
      doc: "class Before {}", documentRevision: 0, visible: true, readOnly: true,
      diagnostics: [], reveal: null, onChange: vi.fn(), onSave: vi.fn(),
      onHover: vi.fn(async () => null), onDefinition: vi.fn(async () => false),
      onReferences: vi.fn(async () => undefined), getCompletionIdentity: () => null,
      onCompletionDiagnostic: vi.fn(),
    };
    const r = render(<CodeMirrorHost {...props} />);
    const view = EditorView.findFromDOM(r.container.querySelector<HTMLElement>(".cm-content")!)!;
    act(() => { owner.replaceDocument("App.java", "disk-watcher", "class After {}", "external-disk"); });
    r.rerender(<CodeMirrorHost {...props} doc="class After {}" documentRevision={1} />);
    r.rerender(<CodeMirrorHost {...props} doc="class After {}" documentRevision={1} readOnly={false} />);
    await waitFor(() => expect(view.state.doc.toString()).toBe("class After {}"));
    expect(props.onChange).not.toHaveBeenCalled();
  });
}
