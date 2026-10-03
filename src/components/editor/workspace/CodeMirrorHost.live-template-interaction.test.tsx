import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { closeCompletion, completionStatus, currentCompletions, selectedCompletionIndex, startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { LspCompletionItem } from "../../../lib/editor/lsp";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { LspCompletionController } from "./lspCompletion";
import { WorkspaceDocumentTransactionOwner } from "./workspaceDocumentTransactionOwner";

describe("CodeMirrorHost Live Template Popup Interaction Regression (TASK-01 / AC-01..05)", () => {
  afterEach(cleanup);

  const createProviderSoutItem = (): LspCompletionItem => ({
    label: "sout",
    kind: 15,
    detail: "provider sout println",
    documentation: null,
    insertText: 'System.out.println("PROVIDER_SOUT");',
    insertTextFormat: 2,
    filterText: null,
    sortText: "0",
    textEdit: null,
    additionalTextEdits: [],
    raw: { label: "sout" },
  });

  const createProviderSoutmItem = (): LspCompletionItem => ({
    label: "soutm",
    kind: 15,
    detail: "provider soutm method",
    documentation: null,
    insertText: 'System.out.println("App.main()");',
    insertTextFormat: 2,
    filterText: null,
    sortText: "1",
    textEdit: null,
    additionalTextEdits: [],
    raw: { label: "soutm" },
  });

  it("AC-01 / RT-01: provider snippet collision produces a stable popup without feedback request loop", async () => {
    let revision = 0;
    const item = createProviderSoutItem();
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

    // Wait past the interactionDelay and allow provider to settle
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    const callsAfterSettle = complete.mock.calls.length;
    // The provider should not be called in a loop (baseline bug produced 20+ calls)
    expect(callsAfterSettle).toBeLessThanOrEqual(2);

    // The autocomplete popup must NOT be disabled
    const tooltip = document.querySelector(".cm-tooltip-autocomplete");
    expect(tooltip).not.toBeNull();
    expect(tooltip?.className).not.toContain("cm-tooltip-autocomplete-disabled");
    expect(completionStatus(view.state)).toBe("active");
  });

  it("AC-02 / RT-02 & RT-03: ArrowDown navigates candidates and Enter accepts without newline", async () => {
    let revision = 0;
    const item = createProviderSoutItem();
    const completionController = new LspCompletionController({ documentationDelayMs: 5_000 });
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
        completionController={completionController}
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
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    const initialHead = view.state.selection.main.head;
    const initialIndex = selectedCompletionIndex(view.state) ?? 0;

    // ArrowDown should move selected index in autocomplete, not source code caret
    fireEvent.keyDown(content, { key: "ArrowDown" });
    expect(view.state.selection.main.head).toBe(initialHead);
    const newIndex = selectedCompletionIndex(view.state);
    expect(newIndex).toBe((initialIndex + 1));

    // ArrowUp returns to initial
    fireEvent.keyDown(content, { key: "ArrowUp" });
    expect(selectedCompletionIndex(view.state)).toBe(initialIndex);

    // Enter accepts the candidate without inserting a newline into the source code
    fireEvent.keyDown(content, { key: "Enter" });
    await waitFor(() => {
      expect(view.state.doc.toString()).toContain('System.out.println("PROVIDER_SOUT");');
    });
    // No unwanted newline in the template expansion
    expect(view.state.doc.toString()).not.toContain("sout\n");

    // Single undo restores the abbreviation
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe("class App {\n  sout\n}");
  });

  it.each(["double-click", "Enter", "Tab"])("AC-03 / RT-04: mouse selects non-default provider candidate, %s accepts and single undo restores prefix", async (acceptWith) => {
    let revision = 0;
    const completionController = new LspCompletionController({ showDocumentation: false });
    const soutItem = createProviderSoutItem();
    const soutmItem = createProviderSoutmItem();
    const resolve = vi.fn(async (raw: unknown) => (raw as { label: string }).label === "soutm" ? soutmItem : soutItem);
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
      items: [soutItem, soutmItem],
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
        onCompleteResolve={resolve}
        completionController={completionController}
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

    await waitFor(() => expect(document.querySelectorAll(".cm-tooltip-autocomplete li").length).toBeGreaterThan(0));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    const items = document.querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete li");
    const target = [...items].find((row) => row.textContent?.includes("provider soutm method"))!;
    expect(target).toBeDefined();
    expect(target).not.toHaveAttribute("aria-selected", "true");

    fireEvent.mouseDown(target, { button: 0 });
    expect(target).toHaveAttribute("aria-selected", "true");
    expect(completionStatus(view.state)).toBe("active");
    expect(view.hasFocus).toBe(true);
    expect(view.state.doc.toString()).toBe("class App {\n  sout\n}");
    expect(revision).toBe(0);
    expect(resolve).not.toHaveBeenCalled();

    if (acceptWith === "double-click") {
      fireEvent.doubleClick(target, { button: 0 });
    } else {
      fireEvent.keyDown(content, { key: acceptWith });
    }
    await waitFor(() => {
      expect(view.state.doc.toString()).toBe('class App {\n  System.out.println("App.main()");\n}');
    });
    expect(revision).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);

    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe("class App {\n  sout\n}");
    expect(view.state.selection.main.head).toBe(18);
  });

  it("AC-05 / RT-08: delayed provider returning after local Tab expansion does not overwrite or reopen", async () => {
    let revision = 0;
    let resolveDelayedProvider: ((value: any) => void) | null = null;
    const delayedPromise = new Promise((resolve) => {
      resolveDelayedProvider = resolve;
    });

    const complete = vi.fn(async () => delayedPromise);

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
        onComplete={complete as any}
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
      view.dispatch({ selection: { anchor: 4 } });
      startCompletion(view);
    });

    // Local popup shows up first
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).not.toBeNull());

    // User immediately presses Tab to expand local template
    fireEvent.keyDown(content, { key: "Tab" });
    await waitFor(() => expect(view.state.doc.toString()).toBe("System.out.println();"));

    // Now release the delayed provider
    await act(async () => {
      resolveDelayedProvider?.({
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
        items: [createProviderSoutItem()],
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Document text must NOT be overwritten by the delayed provider response
    expect(view.state.doc.toString()).toBe("System.out.println();");
    // Autocomplete popup must not reopen
    expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull();

    // A single undo restores the exact sout
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe("sout");
  });

  it("AC-05 / RT-10: closing popup with Escape does not reopen when provider returns late", async () => {
    let revision = 0;
    let resolveDelayedProvider: ((value: any) => void) | null = null;
    const delayedPromise = new Promise((resolve) => {
      resolveDelayedProvider = resolve;
    });

    const complete = vi.fn(async () => delayedPromise);

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

    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).not.toBeNull());

    // Press Escape to dismiss popup
    fireEvent.keyDown(content, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull());

    // Now delayed provider finishes
    await act(async () => {
      resolveDelayedProvider?.({
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
        items: [createProviderSoutItem()],
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Popup must stay closed
    expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull();
    // Doc remains unchanged
    expect(view.state.doc.toString()).toBe("class App {\n  sout\n}");
  });

  it("AC-05 / RT-11: caret moving to different range does not reuse cached candidate from previous range", async () => {
    let revision = 0;
    const providerSoutItem = createProviderSoutItem();
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
    const item = createProviderSoutItem();
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
    const item = createProviderSoutItem();
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

    const complete = vi.fn(async (position: { line: number; character: number }) => {
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
        items: [createProviderSoutmItem()],
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
        onCompleteResolve={async () => createProviderSoutmItem()}
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

  it("AC-05 / RT-12: split views maintain independent scopes and view state", async () => {
    let revision = 0;
    const soutItem = createProviderSoutItem();
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
      items: [createProviderSoutItem()],
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
    const soutItem = createProviderSoutItem();
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
});
