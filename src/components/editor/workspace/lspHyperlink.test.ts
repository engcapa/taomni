import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createLspHyperlinkExtension, identifierRangeAt } from "./lspHyperlink";

describe("identifierRangeAt", () => {
  it("finds a simple identifier under the caret", () => {
    expect(identifierRangeAt("foo.bar()", 5)).toEqual({ from: 4, to: 7 });
    expect(identifierRangeAt("foo.bar()", 4)).toEqual({ from: 4, to: 7 });
    expect(identifierRangeAt("foo.bar()", 7)).toEqual({ from: 4, to: 7 });
  });

  it("supports Java/TS-ish characters", () => {
    expect(identifierRangeAt("map.get($value)", 10)).toEqual({ from: 8, to: 14 });
    expect(identifierRangeAt("List<String>", 6)).toEqual({ from: 5, to: 11 });
  });

  it("returns null on punctuation or pure numbers", () => {
    expect(identifierRangeAt("a + b", 2)).toBeNull();
    expect(identifierRangeAt("x = 42;", 5)).toBeNull();
  });

  it("does not dispatch while CodeMirror is applying a document update", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "foo();",
        extensions: [
          createLspHyperlinkExtension({
            onDefinition: vi.fn(),
          }),
        ],
      }),
      parent,
    });
    vi.spyOn(view, "posAtCoords").mockReturnValue(1);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    view.contentDOM.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      ctrlKey: true,
      clientX: 1,
      clientY: 1,
    }));
    view.dispatch({ changes: { from: 0, insert: "x" } });

    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("CodeMirror plugin crashed:"),
      expect.anything(),
    );

    view.destroy();
    consoleError.mockRestore();
    parent.remove();
  });
});
