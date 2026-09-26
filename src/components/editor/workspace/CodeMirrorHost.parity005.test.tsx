import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { LspCompletionItem, LspDocumentStatus } from "../../../lib/editor/lsp";
import {
  hasPendingCompletionAcceptance,
  recentCompletionTelemetry,
  resetCompletionTelemetry,
  type CompletionRequestIdentity,
} from "./lspCompletion";
import { CodeMirrorHost } from "./CodeMirrorHost";

const DOC = [
  "class Main {",
  "    void sample() {",
  "        StringUtiSuffix;",
  "    }",
  "}",
  "",
].join("\n");

// 0-based line 2, columns 8..23; the caret sits after "StringUti" at 17.
const LINE = 2;
const PREFIX_FROM = 8;
const CARET = 17;
const WORD_END = 23;

const IMPORT = "import org.apache.commons.lang3.StringUtils;\n";

function javaStatus(): LspDocumentStatus {
  return {
    path: "Main.java",
    uri: "file:///Main.java",
    presetId: "java",
    languageId: "java",
    displayName: "Java",
    available: true,
    active: true,
    selectedCommandId: null,
    selectedCommand: null,
    installHint: null,
    error: null,
  };
}

function dualRangeItem(additionalTextEdits: LspCompletionItem["additionalTextEdits"] = []): LspCompletionItem {
  const insert = { start: { line: LINE, character: PREFIX_FROM }, end: { line: LINE, character: CARET } };
  const replace = { start: { line: LINE, character: PREFIX_FROM }, end: { line: LINE, character: WORD_END } };
  return {
    label: "StringUtils",
    kind: 7,
    detail: "org.apache.commons.lang3.StringUtils",
    documentation: null,
    insertText: null,
    insertTextFormat: 1,
    filterText: null,
    sortText: null,
    textEdit: { range: insert, newText: "StringUtils" },
    insertReplaceEdit: { newText: "StringUtils", insert, replace },
    additionalTextEdits,
    raw: { label: "StringUtils", data: "parity005-combined-1" },
  };
}

function completionResult(item: LspCompletionItem) {
  return { status: javaStatus(), isIncomplete: false, items: [item] };
}

interface HostOptions {
  item: LspCompletionItem;
  resolve?: (raw: unknown) => Promise<unknown>;
  identity?: () => CompletionRequestIdentity;
  diagnostic?: (kind: string, detail?: string) => void;
}

function renderHost(options: HostOptions) {
  const identity = options.identity ?? (() => ({
    workspaceId: "ws-parity005",
    fileKey: "Main.java",
    filePath: "Main.java",
    uri: "file:///Main.java",
    languageId: "java",
    documentRevision: 0,
    lspSessionGeneration: 1,
  }));
  const rendered = render(<CodeMirrorHost
    path="Main.java"
    doc={DOC}
    visible
    diagnostics={[]}
    reveal={null}
    onChange={vi.fn()}
    onSave={vi.fn()}
    onHover={async () => null}
    onDefinition={async () => false}
    onReferences={async () => undefined}
    onComplete={async () => completionResult(options.item)}
    onCompleteResolve={options.resolve as never}
    completionTriggers={[]}
    hoverDocumentationDelayMs={0}
    getCompletionIdentity={identity}
    onCompletionDiagnostic={(options.diagnostic ?? vi.fn()) as never}
  />);
  const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  return { rendered, content, view };
}

function focusCaret(view: EditorView): void {
  act(() => {
    view.focus();
    view.dispatch({
      selection: {
        anchor: view.state.doc.line(LINE + 1).from + CARET,
      },
    });
  });
}

async function openPopup(view: EditorView, content: HTMLElement): Promise<void> {
  act(() => { startCompletion(view); });
  await waitFor(() =>
    expect(document.querySelectorAll(".cm-tooltip-autocomplete li").length).toBeGreaterThan(0));
  // CodeMirror ignores accept keys during its 75 ms interaction delay after
  // the list opens; a real user physically cannot beat it either.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  expect(content).toBeTruthy();
}

describe("ED-PARITY-005 CodeMirrorHost acceptance intent", () => {
  afterEach(() => {
    cleanup();
    resetCompletionTelemetry();
  });

  it.each(["Enter", "Tab", "mouse"])(
    "ED-PARITY-005 Enter Tab and mouse route distinct range intent (%s)",
    async (acceptWith) => {
      // Committed directly from the item's own additional edits so the range
      // intent is the only variable under test.
      const item = dualRangeItem([{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: IMPORT,
      }]);
      const diagnostic = vi.fn();
      const { content, view } = renderHost({ item, diagnostic });
      focusCaret(view);
      await openPopup(view, content);

      if (acceptWith === "mouse") {
        fireEvent.mouseDown(document.querySelectorAll(".cm-tooltip-autocomplete li")[0], { button: 0 });
      } else {
        fireEvent.keyDown(content, { key: acceptWith });
      }

      const expectReplace = acceptWith === "Tab";
      await waitFor(() => {
        expect(view.state.doc.toString()).toContain(
          expectReplace ? "        StringUtils;" : "        StringUtilsSuffix;",
        );
      });
      const text = view.state.doc.toString();
      expect(text).toContain(IMPORT);
      if (expectReplace) {
        expect(text).not.toContain("StringUtilsSuffix");
      }
      // The intent actually used is observable in the read-only telemetry ring.
      const applied = recentCompletionTelemetry().filter((event) => event.phase === "applied");
      expect(applied).toHaveLength(1);
      expect(applied[0].acceptIntent).toBe(expectReplace ? "replace" : "insert");
      expect(applied[0].acceptRange).toBe(expectReplace ? "provider-replace" : "provider-insert");
      expect(diagnostic).not.toHaveBeenCalled();
    },
  );

  it("ED-PARITY-005 invalidates acceptance when project facts change", async () => {
    let generation = 4;
    const diagnostic = vi.fn();
    const item = dualRangeItem([{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      newText: IMPORT,
    }]);
    const { content, view } = renderHost({
      item,
      diagnostic,
      identity: () => ({
        workspaceId: "ws-parity005",
        fileKey: "Main.java",
        filePath: "Main.java",
        uri: "file:///Main.java",
        languageId: "java",
        documentRevision: 0,
        lspSessionGeneration: 1,
        projectScope: {
          status: "ready",
          scope: "module",
          moduleId: "parity005",
          sourceKind: "main",
          dependencies: ["commons-lang3"],
          classpathFingerprint: "cp-1",
          generation,
        },
      }),
    });
    focusCaret(view);
    await openPopup(view, content);

    // The project facts generation moves before the key is accepted: the
    // candidate minted for G4 must not be applied to G5.
    generation = 5;
    fireEvent.keyDown(content, { key: "Enter" });

    await waitFor(() => expect(diagnostic).toHaveBeenCalled());
    expect(view.state.doc.toString()).toBe(DOC);
    expect(diagnostic.mock.calls.some(([kind]) => kind === "identity-mismatch")).toBe(true);
  });

  it("ED-PARITY-005 escape cancels pending acceptance without revival", async () => {
    let releaseResolve: ((value: unknown) => void) | null = null;
    const pending = new Promise((resolve) => { releaseResolve = resolve; });
    const item = dualRangeItem();
    const diagnostic = vi.fn();
    const { content, view } = renderHost({
      item,
      diagnostic,
      resolve: () => pending,
    });
    focusCaret(view);
    await openPopup(view, content);
    fireEvent.keyDown(content, { key: "Enter" });

    // The provider is still resolving: Escape must terminate the session.
    // The acceptance is waiting on the held provider promise.
    await waitFor(() => expect(hasPendingCompletionAcceptance(view)).toBe(true));
    fireEvent.keyDown(content, { key: "Escape" });
    expect(hasPendingCompletionAcceptance(view)).toBe(false);
    act(() => {
      releaseResolve!({
        kind: "resolved",
        item: dualRangeItem([{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: IMPORT,
        }]),
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(view.state.doc.toString()).toBe(DOC);
    expect(document.querySelector('[data-testid="completion-resolve-gate"]')).toBeNull();
  });

  it("ED-PARITY-005 old gate callbacks cannot replace a new gate", async () => {
    let retryRelease: ((value: unknown) => void) | null = null;
    let holdNextResolve = false;
    const unavailable = { kind: "unavailable", reason: "provider-returned-null" };
    const diagnostic = vi.fn();
    const { content, view } = renderHost({
      item: dualRangeItem(),
      diagnostic,
      resolve: () => {
        if (holdNextResolve) {
          holdNextResolve = false;
          return new Promise((resolve) => { retryRelease = resolve; });
        }
        return Promise.resolve(unavailable);
      },
    });
    focusCaret(view);
    await openPopup(view, content);
    fireEvent.keyDown(content, { key: "Enter" });

    // Gate A for the first candidate.
    await waitFor(() =>
      expect(document.querySelector('[data-testid="completion-resolve-gate"]')).not.toBeNull());
    expect(view.state.doc.toString()).toBe(DOC);

    // Retry A is in flight (held) while a new acceptance opens gate B.
    holdNextResolve = true;
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="completion-resolve-gate-retry"]')!);
    });
    await waitFor(() => expect(retryRelease).not.toBeNull());
    holdNextResolve = false;

    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.line(LINE + 1).from + CARET } });
    });
    await openPopup(view, content);
    fireEvent.keyDown(content, { key: "Enter" });
    // Gate B for the second acceptance.
    await waitFor(() => expect(
      document.querySelector('[data-testid="completion-resolve-gate"]'),
    ).not.toBeNull());
    expect(document.querySelector('[data-testid="completion-resolve-gate"]')!.textContent)
      .toContain("StringUtils");

    // Release A's late retry with a full resolve: it must neither commit nor
    // close the newer gate.
    await act(async () => {
      retryRelease!({
        kind: "resolved",
        item: dualRangeItem([{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: IMPORT,
        }]),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(view.state.doc.toString()).toBe(DOC);
    expect(document.querySelector('[data-testid="completion-resolve-gate"]')).not.toBeNull();
  });
});
