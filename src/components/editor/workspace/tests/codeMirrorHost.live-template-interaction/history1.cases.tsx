import { completionStatus, selectedCompletionIndex, startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LspCompletionItem } from "../../../../../lib/editor/lsp";
import { CodeMirrorHost } from "../../CodeMirrorHost";
import { LspCompletionController } from "../../lspCompletion";

export interface registerCodeMirrorHostlivetemplateinteractionHistory1CasesContext {
  createProviderSoutItem: () => LspCompletionItem;
  createProviderSoutmItem: () => LspCompletionItem;
}

export function registerCodeMirrorHostlivetemplateinteractionHistory1Cases(caseContext: registerCodeMirrorHostlivetemplateinteractionHistory1CasesContext) {

  it("AC-01 / RT-01: provider snippet collision produces a stable popup without feedback request loop", async () => {
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
    const item = caseContext.createProviderSoutItem();
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
    const soutItem = caseContext.createProviderSoutItem();
    const soutmItem = caseContext.createProviderSoutmItem();
    const resolve = vi.fn(async (raw: unknown) => (raw as { label: string; }).label === "soutm" ? soutmItem : soutItem);
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
        items: [caseContext.createProviderSoutItem()],
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
        items: [caseContext.createProviderSoutItem()],
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Popup must stay closed
    expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull();
    // Doc remains unchanged
    expect(view.state.doc.toString()).toBe("class App {\n  sout\n}");
  });
}
