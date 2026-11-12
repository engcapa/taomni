import { act, cleanup } from "@testing-library/react";
import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderEditor } from "./tests/codeMirrorHost/harness";
// @ts-expect-error node builtin without DOM+node merged globals (unit fixture only)
import { readFileSync } from "node:fs";

const appThemeCss = readFileSync("src/styles/theme.css", "utf8") as string;
const documentText = "first line\nsecond 中文 line\nfinal selected line\nunselected tail";
const selectedEnd = documentText.indexOf("\nunselected");

function mountEditor(highContrast = false, readOnly = false) {
  const rendered = renderEditor(documentText, vi.fn(), {
    path: "note-selection.md",
    fileKey: "note:selection",
    softWrap: true,
    readOnly,
    ...(highContrast ? {
      appearance: {
        fontFamily: "monospace", fontSizePx: 14, lineHeight: 1.5,
        ligatures: false, colorSchemeId: "app", highContrast: true,
      },
    } : {}),
  });
  const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { ...rendered, view };
}

function activeLine(view: EditorView) {
  const line = view.contentDOM.querySelector<HTMLElement>(".cm-activeLine");
  expect(line).not.toBeNull();
  return line!;
}

function expectTransparentActiveLine(view: EditorView) {
  expect(getComputedStyle(activeLine(view)).backgroundColor).toBe("rgba(0, 0, 0, 0)");
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-app-theme");
  vi.restoreAllMocks();
});

describe("CodeMirrorHost range selection highlighting", () => {
  // jsdom can check the style cascade, not selection-layer geometry or pixels.
  it.each(["light", "dark"])("keeps the selection head transparent with the real %s app tokens", (theme) => {
    document.documentElement.setAttribute("data-app-theme", theme);
    const style = document.createElement("style");
    style.textContent = appThemeCss;
    document.head.append(style);
    try {
      const { view } = mountEditor();
      const tokens = getComputedStyle(document.documentElement);
      const activeFill = tokens.getPropertyValue("--taomni-code-active-line-bg").trim();
      expect(activeFill.replace(/\s/g, "")).toBe(theme === "dark" ? "#24262b" : "rgba(37,99,235,0.07)");
      expect(tokens.getPropertyValue("--taomni-code-selection-bg").trim()).not.toBe(activeFill);
      act(() => { view.dispatch({ selection: { anchor: 0, head: selectedEnd } }); });
      expect(view.state.sliceDoc(0, selectedEnd)).toBe("first line\nsecond 中文 line\nfinal selected line");
      expectTransparentActiveLine(view);
    } finally {
      style.remove();
    }
  });

  it.each([
    { name: "forward multiline", anchor: 2, head: selectedEnd, headLine: "final selected line" },
    { name: "reverse multiline", anchor: selectedEnd, head: 2, headLine: "first line" },
    { name: "single-line", anchor: 2, head: 7, headLine: "first line" },
    { name: "whole document", anchor: 0, head: documentText.length, headLine: "unselected tail" },
  ])("does not cover the $name range at its head line", ({ anchor, head, headLine }) => {
    const { view, onChange } = mountEditor();
    const originalFill = getComputedStyle(activeLine(view)).backgroundColor;
    expect(originalFill).not.toBe("rgba(0, 0, 0, 0)");
    act(() => { view.dispatch({ selection: { anchor, head } }); });

    const selection = view.state.selection.main;
    expect(selection.anchor).toBe(anchor);
    expect(selection.head).toBe(head);
    expect(view.state.sliceDoc(selection.from, selection.to)).toBe(
      documentText.slice(Math.min(anchor, head), Math.max(anchor, head)),
    );
    expect(activeLine(view)).toHaveTextContent(headLine);
    expectTransparentActiveLine(view);
    expect(onChange).not.toHaveBeenCalled();

    act(() => { view.dispatch({ selection: { anchor: head } }); });
    expect(view.state.selection.main.empty).toBe(true);
    expect(getComputedStyle(activeLine(view)).backgroundColor).toBe(originalFill);
    expect(view.state.doc.toString()).toBe(documentText);
  });

  it("also clears an explicit high-contrast appearance fill and restores it for the caret", () => {
    const { view } = mountEditor(true);
    const originalFill = getComputedStyle(activeLine(view)).backgroundColor;
    expect(originalFill).not.toBe("rgba(0, 0, 0, 0)");
    act(() => { view.dispatch({ selection: { anchor: 0, head: selectedEnd } }); });
    expectTransparentActiveLine(view);
    expect(view.contentDOM).toHaveAttribute("data-editor-color-scheme", "high-contrast");
    act(() => { view.dispatch({ selection: { anchor: selectedEnd } }); });
    expect(getComputedStyle(activeLine(view)).backgroundColor).toBe(originalFill);
  });

  it("handles a selected secondary range even when the primary range is an empty caret", () => {
    const { view } = mountEditor();
    act(() => { view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.range(11, selectedEnd),
      ], 0),
    }); });
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.ranges[1].empty).toBe(false);
    for (const line of view.contentDOM.querySelectorAll<HTMLElement>(".cm-activeLine")) {
      expect(getComputedStyle(line).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    }
    expect(view.state.sliceDoc(11, selectedEnd)).toBe("second 中文 line\nfinal selected line");
  });

  it("preserves replacement and undo of the full range including the final selected line", () => {
    const { view, onChange } = mountEditor();
    act(() => { view.dispatch({ selection: { anchor: 0, head: selectedEnd } }); });
    act(() => { view.dispatch(view.state.replaceSelection("replacement")); });
    expect(view.state.doc.toString()).toBe("replacement\nunselected tail");
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("replacement\nunselected tail");
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe(documentText);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      documentText.slice(0, selectedEnd),
    );
    expectTransparentActiveLine(view);
  });

  it("keeps a read-only range visible without changing its document", () => {
    const { view, onChange } = mountEditor(false, true);
    act(() => { view.dispatch({ selection: { anchor: 0, head: selectedEnd } }); });
    expectTransparentActiveLine(view);
    act(() => { view.dispatch(view.state.replaceSelection("blocked")); });
    expect(view.state.doc.toString()).toBe(documentText);
    expect(view.state.selection.main.to).toBe(selectedEnd);
    expect(onChange).not.toHaveBeenCalled();
  });
});
