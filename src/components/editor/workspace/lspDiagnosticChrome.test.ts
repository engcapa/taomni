import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticChrome, diagnosticClass } from "./lspDiagnosticChrome";
import type { LspDiagnostic } from "../../../lib/editor/lsp";

function diagnostic(line: number, severity: number, message = "err"): LspDiagnostic {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 4 },
    },
    severity,
    code: null,
    source: "test",
    message,
  };
}

describe("lspDiagnosticChrome", () => {
  it("maps severities to decoration classes", () => {
    expect(diagnosticClass(1)).toContain("error");
    expect(diagnosticClass(2)).toContain("warning");
    expect(diagnosticClass(3)).toContain("info");
  });

  it("builds gutter chrome extensions for diagnostics and lightbulb clicks", () => {
    const onLightbulb = vi.fn();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "line0\nline1\nline2\n",
        extensions: createDiagnosticChrome(
          [diagnostic(0, 1), diagnostic(2, 2)],
          onLightbulb,
        ),
      }),
      parent,
    });

    const bulbs = parent.querySelectorAll('[data-testid="code-workspace-lightbulb"]');
    expect(bulbs.length).toBeGreaterThanOrEqual(1);
    (bulbs[0] as HTMLButtonElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onLightbulb).toHaveBeenCalled();

    expect(parent.querySelector(".cm-lsp-diag-gutter")).toBeTruthy();
    expect(parent.querySelector(".cm-lsp-overview-gutter")).toBeTruthy();

    view.destroy();
    parent.remove();
  });
});
