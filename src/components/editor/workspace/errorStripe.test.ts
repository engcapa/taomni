import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { collectErrorStripeMarks, createErrorStripe } from "./errorStripe";
import { createRunGutter, javaMainRunLines } from "./runGutter";

const DOC = [
  "class A {",
  "  // TODO: tidy",
  "  int x = \"s\";",
  "  int y;",
  "  /* FIXME later */",
  "}",
].join("\n");

const range = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 1 } });

describe("ED-PARITY-022 error stripe", () => {
  it("collects diagnostics, VCS changes, usages and TODO/FIXME marks by line, hints excluded", () => {
    const state = EditorState.create({ doc: DOC });
    const marks = collectErrorStripeMarks(state, {
      diagnostics: [
        { range: range(2), severity: 1, code: null, source: null, message: "incompatible types" },
        { range: range(3), severity: 2, code: null, source: null, message: "unused" },
        { range: range(3), severity: 4, code: null, source: null, message: "hint" },
        { range: range(40), severity: 1, code: null, source: null, message: "out of range" },
      ],
      gitChanges: [{ kind: "modified", startLine: 3, endLine: 3, oldStartLine: 3, oldEndLine: 3, oldText: "  int z;", newText: "  int y;" }],
      usages: [{ range: range(3), kind: 2 }],
    });
    expect(marks.map((mark) => `${mark.line}:${mark.kind}`)).toEqual([
      "1:todo",
      "2:error",
      "3:warning",
      "3:git-modified",
      "3:usage",
      "4:todo",
    ]);
  });

  it("renders clickable marks that move the caret without editing", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: createErrorStripe({
          diagnostics: [{ range: range(2), severity: 1, code: null, source: null, message: "boom" }],
          gitChanges: [],
          usages: [],
        }),
      }),
      parent,
    });
    const stripe = parent.querySelector('[data-testid="code-workspace-error-stripe"]');
    expect(stripe).not.toBeNull();
    const error = parent.querySelector<HTMLElement>('[data-testid="code-workspace-error-stripe-mark"][data-kind="error"]');
    expect(error?.getAttribute("data-line")).toBe("3");
    error!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
    expect(parent.querySelector('[data-testid="code-workspace-error-stripe"]')).toBeNull();
    parent.remove();
  });
});

describe("ED-PARITY-022 run gutter", () => {
  it("finds the main method and its top-level type", () => {
    const text = "package p;\n\npublic class App {\n    public static void main(String[] args) {}\n}\n";
    expect(javaMainRunLines(text)).toEqual({ classLine: 2, mainLine: 3 });
    expect(javaMainRunLines("class B {}\n").mainLine).toBeNull();
  });

  it("shows markers only for provided targets and reports clicks", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const clicks: number[] = [];
    const view = new EditorView({
      state: EditorState.create({
        doc: "a\nb\nc",
        extensions: createRunGutter({ targets: [{ line: 1, label: "App" }], onClick: (target) => clicks.push(target.line) }),
      }),
      parent,
    });
    const markers = parent.querySelectorAll<HTMLElement>('[data-testid="code-workspace-run-gutter"]');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.getAttribute("data-line")).toBe("2");
    markers[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toEqual([1]);
    view.destroy();
    parent.remove();
  });

  it("renders no marker without run facts", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: EditorState.create({ doc: "a", extensions: createRunGutter() }), parent });
    expect(parent.querySelectorAll('[data-testid="code-workspace-run-gutter"]')).toHaveLength(0);
    view.destroy();
    parent.remove();
  });
});
