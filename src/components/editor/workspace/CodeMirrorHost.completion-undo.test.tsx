import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import type { LspCompletionItem } from "../../../lib/editor/lsp";
import {
  WorkspaceDocumentTransactionOwner,
} from "./workspaceDocumentTransactionOwner";
import { createWorkspaceActionHost } from "./workspaceActionHost";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { activeLspSnippetSession } from "./lspCompletion";

/**
 * ED-AUDIT-007 scenario-2 chain: a jdtls overload item arrives as a snippet
 * (`insertTextFormat: 2`, `newText: "append(${1:0})"`, no additionalTextEdits).
 * The accept must commit through the single-dispatch tabstop-session path so
 * the following Tab exits caret-only (never an undoable indent) and one
 * workspace undo reverts the acceptance.
 */
describe("CodeMirrorHost snippet accept then shared-owner undo", () => {
  afterEach(cleanup);

  it("reverts a snippet overload accept through the workspace undo action", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const actionHost = createWorkspaceActionHost({
      workspaceId: "snippet-undo-test",
      getContext: () => ({ focus: "editor" }),
      getDefaultContext: () => ({ focus: "editor" }),
      getDefaultFocus: () => "editor",
    });
    const complete = vi.fn(async () => ({
      status: {
        path: "App.java", uri: "file:///App.java", presetId: "java", languageId: "java",
        displayName: "Java", available: true, active: true, selectedCommandId: null,
        selectedCommand: null, installHint: null, error: null,
      },
      isIncomplete: false,
      items: [{
        label: "append(double d) : StringBuilder",
        kind: 2,
        detail: "StringBuilder.append(double d) : StringBuilder",
        documentation: null,
        insertText: "append",
        insertTextFormat: 2,
        filterText: "append(${1:0})",
        sortText: "999999035",
        textEdit: {
          range: { start: { line: 0, character: 28 }, end: { line: 0, character: 33 } },
          newText: "append(${1:0})",
        },
        raw: { label: "append(double d) : StringBuilder" },
      } as unknown as LspCompletionItem],
    }));
    const resolve = vi.fn(async (raw: unknown) => {
      const { label } = raw as { label: string };
      return (await complete()).items.find((item) => item.label === label)!;
    });
    const rendered = render(<CodeMirrorHost
      path="App.java"
      viewId="view-1"
      doc="        new StringBuilder().appen"
      visible
      diagnostics={[]}
      reveal={null}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onHover={async () => null}
      onDefinition={async () => false}
      onReferences={async () => undefined}
      onComplete={complete}
      onCompleteResolve={resolve}
      completionTriggers={["."]}
      hoverDocumentationDelayMs={0}
      transactionOwner={owner}
      workspaceActionHost={actionHost}
      getCompletionIdentity={() => ({
        workspaceId: "snippet-undo-test", fileKey: "App.java", filePath: "App.java",
        uri: "file:///App.java", languageId: "java", documentRevision: 0,
        lspSessionGeneration: 1,
      })}
      onCompletionDiagnostic={vi.fn()}
    />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(content).toHaveAttribute("data-language", "java"));

    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 33 }, scrollIntoView: true });
    });
    const { startCompletion } = await import("@codemirror/autocomplete");
    act(() => {
      startCompletion(view);
    });
    await waitFor(() => expect(document.querySelectorAll(".cm-tooltip-autocomplete li").length).toBeGreaterThan(0));

    // Walk the selection onto the overload item, then accept with Enter —
    // the same synchronous keydown acceptance surface as the native case.
    for (let steps = 0; steps < 40; steps += 1) {
      const selected = document.querySelector('.cm-tooltip-autocomplete [aria-selected="true"]');
      if (selected?.textContent?.includes("append(double d)")) break;
      fireEvent.keyDown(content, { key: "ArrowDown" });
    }
    const selectedLi = document.querySelector('.cm-tooltip-autocomplete [aria-selected="true"]');
    expect(selectedLi?.textContent).toContain("append(double d)");
    fireEvent.keyDown(content, { key: "Enter" });
    await waitFor(() => expect(view.state.doc.toString()).toBe("        new StringBuilder().append(0)"));
    // The accept owns a tabstop session with the placeholder selected.
    expect(activeLspSnippetSession(view)).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("0");
    // Owner recorded the acceptance as one undoable entry.
    expect(owner.getDocument("App.java")).toBe("        new StringBuilder().append(0)");
    expect(owner.getHistoryState("App.java").canUndo).toBe(true);

    // Tab advances past the (single) field: caret-only exit, no doc change,
    // no second owner entry — the one-undo contract stays intact.
    fireEvent.keyDown(content, { key: "Tab" });
    expect(view.state.doc.toString()).toBe("        new StringBuilder().append(0)");
    expect(view.state.selection.main.head).toBe(36);
    expect(activeLspSnippetSession(view)).toBe(false);
    expect(owner.getDocument("App.java")).toBe("        new StringBuilder().append(0)");
    expect(owner.getHistoryState("App.java").canUndo).toBe(true);

    // Ctrl+Z through the real action-host dispatch (workspace.undo).
    const undoOwnerSpy = vi.spyOn(owner, "undo");
    const event = new KeyboardEvent("keydown", {
      key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true,
    });
    let result: unknown = null;
    act(() => {
      result = actionHost.dispatchKeydownV2({
        event,
        workspaceId: "snippet-undo-test",
        targetViewId: "view-1",
        composing: false,
      });
    });
    await waitFor(() => expect(undoOwnerSpy).toHaveBeenCalled());
    expect(view.state.doc.toString()).toBe("        new StringBuilder().appen");
    expect((result as { kind?: string }).kind).toBe("executed");
    view.destroy();
  });
});
