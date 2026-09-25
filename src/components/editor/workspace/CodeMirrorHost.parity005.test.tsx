import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { LspCompletionItem } from "../../../lib/editor/lsp";
import { createWorkspaceActionHost } from "./workspaceActionHost";
import { CodeMirrorHost } from "./CodeMirrorHost";

/**
 * ED-PARITY-005 lifecycle coverage for the Java Basic Completion acceptance
 * session: provider InsertReplaceEdit routing (Enter/Tab/mouse), project facts
 * generation invalidation, Esc cancellation without revival, and stale resolve
 * gate callbacks that must not touch a newer gate.
 *
 * Only the production browser path is exercised: the real completion source,
 * the real CodeMirror keymap/mouse routing and the real host surfaces.
 */

const MID_WORD_DOC = "        StringUtiSuffix;";
const MID_WORD_CARET = 17;
const IMPORT_EDIT = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  newText: "import org.apache.commons.lang3.StringUtils;\n",
};

function dualRangeItem(label = "StringUtils"): LspCompletionItem {
  return {
    label,
    kind: 7,
    detail: "org.apache.commons.lang3.StringUtils",
    documentation: null,
    insertText: label,
    insertTextFormat: 1,
    filterText: null,
    sortText: "0001",
    textEdit: {
      range: { start: { line: 0, character: 8 }, end: { line: 0, character: 17 } },
      newText: label,
    },
    insertReplaceEdit: {
      newText: label,
      insert: { start: { line: 0, character: 8 }, end: { line: 0, character: 17 } },
      replace: { start: { line: 0, character: 8 }, end: { line: 0, character: 23 } },
    },
    additionalTextEdits: [],
    raw: { label },
  };
}

function javaStatus() {
  return {
    path: "Main.java", uri: "file:///parity005/Main.java", presetId: "java", languageId: "java",
    displayName: "Java", available: true, active: true, selectedCommandId: null,
    selectedCommand: null, installHint: null, error: null,
  };
}

const READY_SCOPE = {
  status: "ready" as const,
  scope: "module" as const,
  moduleId: "parity005",
  sourceKind: "main" as const,
  dependencies: [],
  classpathFingerprint: null,
  generation: 4,
};

interface Harness {
  content: HTMLElement;
  view: EditorView;
  diagnostic: ReturnType<typeof vi.fn>;
  unmount: () => void;
}

function mountHost(options: {
  items: () => LspCompletionItem[];
  resolve: (raw: unknown) => Promise<LspCompletionItem | null>;
  scopeGeneration?: () => number;
  withActionHost?: boolean;
}): Harness {
  let revision = 0;
  const diagnostic = vi.fn();
  const complete = vi.fn(async () => ({
    status: javaStatus(),
    isIncomplete: false,
    items: options.items(),
  }));
  const rendered = render(<CodeMirrorHost
    path="Main.java"
    viewId="parity005-view"
    doc={MID_WORD_DOC}
    visible
    diagnostics={[]}
    reveal={null}
    onChange={() => { revision += 1; }}
    onSave={vi.fn()}
    onHover={async () => null}
    onDefinition={async () => false}
    onReferences={async () => undefined}
    onComplete={complete}
    onCompleteResolve={options.resolve}
    completionTriggers={["."]}
    hoverDocumentationDelayMs={0}
    workspaceActionHost={options.withActionHost
      ? createWorkspaceActionHost({
          workspaceId: "parity005",
          getContext: () => ({ focus: "editor" }),
          getDefaultContext: () => ({ focus: "editor" }),
          getDefaultFocus: () => "editor",
        })
      : undefined}
    getCompletionIdentity={() => ({
      workspaceId: "parity005",
      fileKey: "Main.java",
      filePath: "Main.java",
      uri: "file:///parity005/Main.java",
      languageId: "java",
      documentRevision: revision,
      lspSessionGeneration: 1,
      projectScope: {
        ...READY_SCOPE,
        generation: options.scopeGeneration ? options.scopeGeneration() : READY_SCOPE.generation,
      },
    })}
    onCompletionDiagnostic={diagnostic}
  />);
  const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  return {
    content,
    view,
    diagnostic,
    unmount: () => { view.destroy(); cleanup(); },
  };
}

/** Wait for the provider list, then clear the 75 ms acceptance interaction delay. */
async function openPopup(expectedLabel?: string): Promise<void> {
  await waitFor(() => {
    expect(document.querySelectorAll(".cm-tooltip-autocomplete li").length).toBeGreaterThan(0);
    if (expectedLabel) {
      expect(document.querySelector(".cm-tooltip-autocomplete")?.textContent ?? "")
        .toContain(expectedLabel);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 90));
}

function observation(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="completion-session-observation"]')!;
}

function triggerCompletion(harness: Harness): void {
  act(() => {
    harness.view.focus();
    harness.view.dispatch({ selection: { anchor: MID_WORD_CARET } });
    startCompletion(harness.view);
  });
}

describe("ED-PARITY-005 completion acceptance lifecycle", () => {
  afterEach(cleanup);

  it("ED-PARITY-005 Enter Tab and mouse route distinct range intent", async () => {
    const expectations: Array<{ entry: "Enter" | "Tab" | "mouse"; text: string; intent: string; source: string }> = [
      { entry: "Enter", text: "        StringUtilsSuffix;", intent: "insert", source: "insert-replace-insert" },
      { entry: "Tab", text: "        StringUtils;", intent: "replace", source: "insert-replace-replace" },
      { entry: "mouse", text: "        StringUtilsSuffix;", intent: "insert", source: "insert-replace-insert" },
    ];
    for (const expected of expectations) {
      const harness = mountHost({
        items: () => [dualRangeItem()],
        resolve: async () => ({ ...dualRangeItem(), additionalTextEdits: [IMPORT_EDIT] }),
      });
      await waitFor(() => expect(harness.content).toHaveAttribute("data-language", "java"));
      triggerCompletion(harness);
      await openPopup();

      if (expected.entry === "mouse") {
        fireEvent.mouseDown(document.querySelectorAll(".cm-tooltip-autocomplete li")[0], { button: 0 });
      } else {
        fireEvent.keyDown(harness.content, { key: expected.entry });
      }
      await waitFor(() => {
        expect(harness.view.state.doc.toString()).toContain(expected.text);
      });
      // One dispatch carries primary + import, and the intent that routed the
      // provider range is observable.
      expect(harness.view.state.doc.toString()).toContain("import org.apache.commons.lang3.StringUtils;");
      expect(observation().getAttribute("data-accept-intent")).toBe(expected.intent);
      expect(observation().getAttribute("data-range-source")).toBe(expected.source);
      expect(observation().getAttribute("data-commit-count")).toBe("1");
      harness.unmount();
    }
  });

  it("ED-PARITY-005 invalidates acceptance when project facts change", async () => {
    let generation = READY_SCOPE.generation;
    const item = dualRangeItem();
    const harness = mountHost({
      items: () => [item],
      resolve: async () => item,
      scopeGeneration: () => generation,
    });
    await waitFor(() => expect(harness.content).toHaveAttribute("data-language", "java"));
    triggerCompletion(harness);
    await openPopup();

    // A project facts refresh happened while the candidate was on screen; the
    // candidate was minted against the previous generation and must not commit.
    generation += 1;
    fireEvent.keyDown(harness.content, { key: "Enter" });
    await waitFor(() => expect(harness.diagnostic).toHaveBeenCalled());
    expect(harness.diagnostic).toHaveBeenCalledWith("identity-mismatch", expect.anything());
    expect(harness.view.state.doc.toString()).toBe(MID_WORD_DOC);
    harness.unmount();
  });

  it("ED-PARITY-005 escape cancels pending acceptance without revival", async () => {
    const item = dualRangeItem();
    let releaseResolve: ((value: LspCompletionItem) => void) | null = null;
    const harness = mountHost({
      items: () => [item],
      resolve: () => new Promise<LspCompletionItem>((resolve) => { releaseResolve = resolve; }),
      withActionHost: true,
    });
    await waitFor(() => expect(harness.content).toHaveAttribute("data-language", "java"));
    triggerCompletion(harness);
    await openPopup();

    // Enter starts the acceptance; the provider answer is still in flight.
    fireEvent.keyDown(harness.content, { key: "Enter" });
    await waitFor(() => expect(observation().getAttribute("data-phase")).toBe("accept"));
    fireEvent.keyDown(harness.content, { key: "Escape" });
    await waitFor(() => expect(observation().getAttribute("data-phase")).toBe("cancelled"));

    // The late provider answer must not revive the cancelled acceptance.
    act(() => { releaseResolve?.({ ...item, additionalTextEdits: [IMPORT_EDIT] }); });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.view.state.doc.toString()).toBe(MID_WORD_DOC);
    expect(observation().getAttribute("data-commit-count")).toBe("0");
    harness.unmount();
  });

  it("ED-PARITY-005 old gate callbacks cannot replace a new gate", async () => {
    const first = dualRangeItem("StringUtils");
    // Must still match the typed "StringUti" query so the candidate list keeps
    // it (CodeMirror filters options against the live query text).
    const second = dualRangeItem("StringUtilsBuilder");
    let currentItem = first;
    let holdRetry = false;
    let releaseRetry: ((value: LspCompletionItem) => void) | null = null;
    const harness = mountHost({
      items: () => [currentItem],
      resolve: async (raw) => {
        const label = (raw as { label?: string }).label;
        if (label === "StringUtils") {
          if (holdRetry) {
            return new Promise<LspCompletionItem>((resolve) => { releaseRetry = resolve; });
          }
          return null; // first resolve fails -> gate A
        }
        return second;
      },
    });
    await waitFor(() => expect(harness.content).toHaveAttribute("data-language", "java"));
    triggerCompletion(harness);
    await openPopup();
    fireEvent.keyDown(harness.content, { key: "Enter" });
    await waitFor(() => expect(document.querySelector('[data-testid="completion-resolve-gate"]')).not.toBeNull());

    // Retry is now in flight inside gate A.
    holdRetry = true;
    fireEvent.click(document.querySelector('[data-testid="completion-resolve-gate-retry"]')!);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="completion-resolve-gate-retry"]')).toBeDisabled();
    });

    // A newer, independent acceptance commits and clears gate A.
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull());
    currentItem = second;
    triggerCompletion(harness);
    await openPopup("StringUtilsBuilder");
    fireEvent.keyDown(harness.content, { key: "Enter" });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="completion-resolve-gate"]')).toBeNull();
    });
    await waitFor(() => {
      expect(harness.view.state.doc.toString()).toContain("StringUtilsBuilder");
    });

    // Releasing the old retry must not resurrect the old gate or add an edit.
    const before = harness.view.state.doc.toString();
    act(() => { releaseRetry?.({ ...first, additionalTextEdits: [IMPORT_EDIT] }); });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.querySelector('[data-testid="completion-resolve-gate"]')).toBeNull();
    expect(document.querySelector('[data-testid="completion-resolve-gate-failed-note"]')).toBeNull();
    expect(harness.view.state.doc.toString()).toBe(before);
    harness.unmount();
  });
});
