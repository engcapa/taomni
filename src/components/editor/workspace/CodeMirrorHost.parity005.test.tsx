import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { LspCompletionItem } from "../../../lib/editor/lsp";
import { CodeMirrorHost } from "./CodeMirrorHost";

const before = "package parity005;\n\nStringUtiSuffix;";
const importLine = "import org.apache.commons.lang3.StringUtils;\n";

describe("ED-PARITY-005 completion acceptance", () => {
  afterEach(cleanup);

  it.each([
    ["Enter", "StringUtilsSuffix;"],
    ["Tab", "StringUtils;"],
    ["mouse", "StringUtilsSuffix;"],
  ])("Enter Tab and mouse route distinct range intent: %s", async (entry, body) => {
    let revision = 0;
    const item = {
      label: "StringUtils",
      kind: 7,
      detail: "org.apache.commons.lang3.StringUtils",
      documentation: null,
      insertText: "StringUtils",
      insertTextFormat: 1,
      filterText: null,
      sortText: "0001",
      textEdit: {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 9 } },
        newText: "StringUtils",
      },
      insertReplaceEdit: {
        insert: { start: { line: 2, character: 0 }, end: { line: 2, character: 9 } },
        replace: { start: { line: 2, character: 0 }, end: { line: 2, character: 15 } },
        newText: "StringUtils",
      },
      additionalTextEdits: [{
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
        newText: importLine,
      }],
      raw: { label: "StringUtils" },
    } as LspCompletionItem;
    const complete = vi.fn(async () => ({
      status: {
        path: "Main.java", uri: "file:///Main.java", presetId: "java", languageId: "java",
        displayName: "Java", available: true, active: true, selectedCommandId: null,
        selectedCommand: null, installHint: null, error: null,
      },
      isIncomplete: false,
      items: [item],
    }));
    const rendered = render(<CodeMirrorHost
      path="Main.java"
      doc={before}
      visible
      diagnostics={[]}
      reveal={null}
      onChange={() => { revision += 1; }}
      onSave={vi.fn()}
      onHover={async () => null}
      onDefinition={async () => false}
      onReferences={async () => undefined}
      onComplete={complete}
      onCompleteResolve={async () => item}
      getCompletionIdentity={() => ({
        workspaceId: "parity005", fileKey: "Main.java", filePath: "Main.java",
        uri: "file:///Main.java", languageId: "java", documentRevision: revision,
        lspSessionGeneration: 1,
      })}
      onCompletionDiagnostic={vi.fn()}
    />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(content).toHaveAttribute("data-language", "java"));
    const caret = view.state.doc.line(3).from + 9;
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: caret } });
      startCompletion(view);
    });
    await waitFor(() => expect([...document.querySelectorAll(".cm-tooltip-autocomplete li")]
      .some((row) => row.textContent?.includes("StringUtils"))).toBe(true));
    const selectedLabel = () => document.querySelector('.cm-tooltip-autocomplete [aria-selected="true"] .cm-completionLabel')?.textContent;
    for (let index = 0; index < 40 && selectedLabel() !== "StringUtils"; index += 1) {
      fireEvent.keyDown(content, { key: "ArrowDown" });
    }
    expect(selectedLabel()).toBe("StringUtils");
    // CodeMirror intentionally blocks keyboard acceptance for 75 ms after opening.
    await new Promise((resolve) => setTimeout(resolve, 90));

    if (entry === "mouse") {
      const row = [...document.querySelectorAll(".cm-tooltip-autocomplete li")]
        .find((element) => element.querySelector(".cm-completionLabel")?.textContent === "StringUtils");
      expect(row).toHaveClass("cm-lsp-provider-option");
      expect(row?.closest("ul")?.id).toBe(view.contentDOM.getAttribute("aria-controls"));
      fireEvent.mouseDown(row!, { button: 0 });
      expect(view.state.doc.toString()).toBe(before);
      fireEvent.doubleClick(row!, { button: 0 });
    } else {
      fireEvent.keyDown(content, { key: entry });
    }
    await waitFor(() => expect(view.state.doc.toString()).toBe(`package parity005;\n${importLine}\n${body}`));
    expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from + "StringUtils".length);
    expect(revision).toBe(1);
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.selection.main.head).toBe(caret);
  });
});
