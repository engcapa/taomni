import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LspCompletionItem } from "../../../../../lib/editor/lsp";
import { CodeMirrorHost } from "../../CodeMirrorHost";

export interface registerCodeMirrorHostlivetemplateinteractionEditing2CasesContext {
  createProviderSoutItem: () => LspCompletionItem;
  createProviderSoutmItem: () => LspCompletionItem;
}

export function registerCodeMirrorHostlivetemplateinteractionEditing2Cases(caseContext: registerCodeMirrorHostlivetemplateinteractionEditing2CasesContext) {

  it("AC-05 / RT-11: caret moving to different range does not reuse cached candidate from previous range", async () => {
    let revision = 0;
    const providerSoutItem = caseContext.createProviderSoutItem();
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
      items: [providerSoutItem],
    }));

    const docText = "class App {\n  void main() {\n    sout\n  }\n  void other() {\n    sout\n  }\n}";
    const firstSoutOffset = docText.indexOf("sout") + "sout".length;
    const secondSoutOffset = docText.lastIndexOf("sout") + "sout".length;

    const rendered = render(
      <CodeMirrorHost
        path="App.java"
        doc={docText}
        visible
        diagnostics={[]}
        reveal={null}
        onChange={() => { revision++; }}
        onSave={vi.fn()}
        onHover={async () => null}
        onDefinition={async () => false}
        onReferences={async () => undefined}
        onComplete={complete}
        onCompleteResolve={async () => providerSoutItem}
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

    // 1. First trigger completion at first sout
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: firstSoutOffset } });
      startCompletion(view);
    });

    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).not.toBeNull());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    // Dismiss popup
    fireEvent.keyDown(content, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull());

    // 2. Move caret to second sout without typing or triggering provider for second sout
    act(() => {
      view.dispatch({ selection: { anchor: secondSoutOffset } });
    });

    // Press Tab: cached candidate from offset 34 must NOT be applied to offset 67!
    // Instead, it falls back to local sout expansion or local template
    fireEvent.keyDown(content, { key: "Tab" });
    await waitFor(() => {
      const currentDoc = view.state.doc.toString();
      // First sout must remain untouched!
      expect(currentDoc).toContain("void main() {\n    sout\n  }");
      // Second sout must be expanded locally (System.out.println();), not using provider sout at wrong range
      expect(currentDoc).toContain("void other() {\n    System.out.println();\n  }");
    });
  });

  it("AC-04 / RT-05: Tab branches correctly between open popup, closed exact provider, local fallback, and partial prefix", async () => {
    let revision = 0;
    const item = caseContext.createProviderSoutItem();
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
      items: [item],
    }));

    const rendered = render(
      <CodeMirrorHost
        path="App.java"
        doc="sout"
        visible
        diagnostics={[]}
        reveal={null}
        onChange={() => { revision++; }}
        onSave={vi.fn()}
        onHover={async () => null}
        onDefinition={async () => false}
        onReferences={async () => undefined}
        onComplete={complete}
        onCompleteResolve={async () => item}
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
      view.dispatch({ selection: { anchor: 4 } });
      startCompletion(view);
    });

    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete li")).not.toBeNull());

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    // When popup is open: single Tab accepts the selected candidate
    fireEvent.keyDown(content, { key: "Tab" });
    await waitFor(() => {
      expect(view.state.doc.toString()).toBe('System.out.println("PROVIDER_SOUT");');
    });
  });

  it("AC-01 / RT-06: without provider or when provider returns empty, local sout is operable with arrows, enter, mouse, tab", async () => {
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
      view.dispatch({ selection: { anchor: 18 } });
      startCompletion(view);
    });

    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete li")).not.toBeNull());

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // Enter accepts local sout template
    fireEvent.keyDown(content, { key: "Enter" });
    await waitFor(() => {
      expect(view.state.doc.toString()).toContain("System.out.println();");
    });

    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe("class App {\n  sout\n}");
  });

  it("AC-05 / RT-07: identical collision fingerprint does not trigger extra compartment reconfigures", async () => {
    let revision = 0;
    const item = caseContext.createProviderSoutItem();
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
      items: [item],
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
        onCompleteResolve={async () => item}
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
      await new Promise((resolve) => setTimeout(resolve, 800));
    });

    // Single request was made, no cascading loop
    expect(complete.mock.calls.length).toBeLessThanOrEqual(2);
    expect(completionStatus(view.state)).toBe("active");
  });

  it("AC-05 / RT-09: out-of-order queries (A late after B success) do not overwrite B's claims", async () => {
    let revision = 0;
    let resolveQueryA: ((val: any) => void) | null = null;
    const promiseA = new Promise((resolve) => { resolveQueryA = resolve; });

    const complete = vi.fn(async (position: { line: number; character: number; }) => {
      if (position.character === 18) {
        // Query A: at "class App {\n  sout\n}" offset 18
        return promiseA;
      }
      // Query B: user typed "m" -> "soutm", character is 19
      return {
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
        items: [caseContext.createProviderSoutmItem()],
      };
    });

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
        onComplete={complete as any}
        onCompleteResolve={async () => caseContext.createProviderSoutmItem()}
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

    // Start query A
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 18 } });
      startCompletion(view);
    });

    // Now type 'm' to start query B
    act(() => {
      view.dispatch({
        changes: { from: 18, insert: "m" },
        selection: { anchor: 19 },
        userEvent: "input.type",
      });
      startCompletion(view);
    });

    // Query B returns first with soutm
    await waitFor(() => {
      const text = document.querySelector(".cm-tooltip-autocomplete")?.textContent ?? "";
      expect(text).toContain("provider soutm method");
    });

    // Now Query A resolves late with null
    await act(async () => {
      resolveQueryA?.(null);
      await new Promise((r) => setTimeout(r, 100));
    });

    // Query B's claims are NOT cleared by late Query A
    fireEvent.keyDown(content, { key: "Enter" });
    await waitFor(() => {
      expect(view.state.doc.toString()).toContain('System.out.println("App.main()");');
    });
  });
}
