import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LspCompletionItem } from "../../../../../lib/editor/lsp";
import { CodeMirrorHost } from "../../CodeMirrorHost";

export interface registerCodeMirrorHostlivetemplateinteractionCompletion3CasesContext {
  createProviderSoutItem: () => LspCompletionItem;
}

export function registerCodeMirrorHostlivetemplateinteractionCompletion3Cases(caseContext: registerCodeMirrorHostlivetemplateinteractionCompletion3CasesContext) {

  it("AC-05 / RT-12: split views maintain independent scopes and view state", async () => {
    let revision = 0;
    const soutItem = caseContext.createProviderSoutItem();
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
      items: [soutItem],
    }));

    const r1 = render(
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
        onCompleteResolve={async () => soutItem}
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

    const r2 = render(
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
        onCompleteResolve={async () => soutItem}
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

    const content1 = r1.container.querySelector<HTMLElement>(".cm-content")!;
    const view1 = EditorView.findFromDOM(content1)!;
    const content2 = r2.container.querySelector<HTMLElement>(".cm-content")!;
    const view2 = EditorView.findFromDOM(content2)!;

    await waitFor(() => expect(content1).toHaveAttribute("data-language", "java"));
    await waitFor(() => expect(content2).toHaveAttribute("data-language", "java"));

    // Trigger completion in View 1 only
    act(() => {
      view1.focus();
      view1.dispatch({ selection: { anchor: 18 } });
      startCompletion(view1);
    });

    await waitFor(() => expect(completionStatus(view1.state)).toBe("active"));
    // View 2 must have no active completion
    expect(completionStatus(view2.state)).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    // Accept in View 1
    fireEvent.keyDown(content1, { key: "Enter" });
    await waitFor(() => {
      expect(view1.state.doc.toString()).toContain('System.out.println("PROVIDER_SOUT");');
    });

    // View 2 document remains untouched
    expect(view2.state.doc.toString()).toBe("class App {\n  sout\n}");
  });

  it("AC-06 / RT-16: postfix template list.for replaces expression cleanly", async () => {
    let revision = 0;
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
      items: [],
    }));

    const rendered = render(
      <CodeMirrorHost
        path="App.java"
        doc={"class App {\n  void test(List<String> list) {\n    list.for\n  }\n}"}
        visible
        diagnostics={[]}
        reveal={null}
        onChange={() => { revision++; }}
        onSave={vi.fn()}
        onHover={async () => null}
        onDefinition={async () => false}
        onReferences={async () => undefined}
        onComplete={complete}
        onCompleteResolve={async () => null}
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

    const targetPos = view.state.doc.toString().indexOf("list.for") + "list.for".length;
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: targetPos } });
    });

    // Single Tab expands postfix list.for
    fireEvent.keyDown(content, { key: "Tab" });
    await waitFor(() => {
      const doc = view.state.doc.toString();
      expect(doc).toContain(": list)");
      // Does not duplicate list.
      expect(doc).not.toContain("list.for (");
    });
  });

  it("AC-06 / RT-17: Java provider templates do not claim JavaScript templates", async () => {
    let revision = 0;
    const complete = vi.fn(async () => ({
      status: {
        path: "app.js",
        uri: "file:///app.js",
        presetId: "typescript",
        languageId: "javascript",
        displayName: "JavaScript",
        available: true,
        active: true,
        selectedCommandId: null,
        selectedCommand: null,
        installHint: null,
        error: null,
      },
      isIncomplete: false,
      items: [caseContext.createProviderSoutItem()],
    }));

    const rendered = render(
      <CodeMirrorHost
        path="app.js"
        doc="clg"
        visible
        diagnostics={[]}
        reveal={null}
        onChange={() => { revision++; }}
        onSave={vi.fn()}
        onHover={async () => null}
        onDefinition={async () => false}
        onReferences={async () => undefined}
        onComplete={complete}
        onCompleteResolve={async () => null}
        completionTriggers={["."]}
        hoverDocumentationDelayMs={0}
        onCompletionDiagnostic={vi.fn()}
        getCompletionIdentity={() => ({
          workspaceId: "workspace",
          fileKey: "app.js",
          filePath: "app.js",
          uri: "file:///app.js",
          languageId: "javascript",
          documentRevision: revision,
          lspSessionGeneration: 1,
        })}
      />,
    );

    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(content).toHaveAttribute("data-language", "javascript"));

    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 3 } });
    });

    // Tab expands JS clg template to console.log($0)
    fireEvent.keyDown(content, { key: "Tab" });
    await waitFor(() => {
      expect(view.state.doc.toString()).toBe("console.log();");
    });
  });

  it("AC-07 / RT-18: with popup closed, arrow keys, Enter, and Tab perform normal editor actions", async () => {
    let revision = 0;
    const rendered = render(
      <CodeMirrorHost
        path="App.java"
        doc={"line 1\nline 2"}
        visible
        diagnostics={[]}
        reveal={null}
        onChange={() => { revision++; }}
        onSave={vi.fn()}
        onHover={async () => null}
        onDefinition={async () => false}
        onReferences={async () => undefined}
        onComplete={async () => null}
        onCompleteResolve={async () => null}
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
      view.dispatch({ selection: { anchor: 0 } });
    });

    expect(completionStatus(view.state)).toBeNull();

    // ArrowDown navigates lines in editor
    fireEvent.keyDown(content, { key: "ArrowDown" });
    expect(view.state.selection.main.head).toBeGreaterThan(0);

    // ArrowUp navigates back
    fireEvent.keyDown(content, { key: "ArrowUp" });
    expect(view.state.selection.main.head).toBe(0);
  });

  it("AC-07 / RT-20: readOnly editor does not accept completions into document", async () => {
    let revision = 0;
    const soutItem = caseContext.createProviderSoutItem();
    const rendered = render(
      <CodeMirrorHost
        path="App.java"
        doc={"class App {\n  sout\n}"}
        visible
        readOnly
        diagnostics={[]}
        reveal={null}
        onChange={() => { revision++; }}
        onSave={vi.fn()}
        onHover={async () => null}
        onDefinition={async () => false}
        onReferences={async () => undefined}
        onComplete={async () => ({
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
          items: [soutItem],
        })}
        onCompleteResolve={async () => soutItem}
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

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    const option = document.querySelector(".cm-tooltip-autocomplete li");
    if (option) {
      fireEvent.mouseDown(option, { button: 0 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }

    // Mouse click in readOnly does not modify document
    expect(view.state.doc.toString()).toBe("class App {\n  sout\n}");

    // Enter in readOnly does not modify document
    fireEvent.keyDown(content, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("class App {\n  sout\n}");

    // Tab in readOnly does not modify document
    fireEvent.keyDown(content, { key: "Tab" });
    expect(view.state.doc.toString()).toBe("class App {\n  sout\n}");
  });
}
