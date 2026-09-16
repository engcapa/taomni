import { describe, expect, it, vi } from "vitest";
import { identifierRangeAt } from "./lspHyperlink";

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
});

describe("lspHyperlink plugin", () => {
  it("does not let a queued blur clear a newer hover and ignores work after destroy", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { createLspHyperlinkExtension } = await import("./lspHyperlink");
    const onDefinition = vi.fn(() => true);
    const view = new EditorView({ parent: document.body, state: EditorState.create({
      doc: "tree", extensions: [createLspHyperlinkExtension({ onDefinition })],
    }) });
    const position = vi.spyOn(view, "posAtCoords").mockReturnValue(2);
    const hover = () => view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ctrlKey: true }));
    try {
      view.contentDOM.focus(); hover();
      expect(view.dom.querySelector(".cm-lsp-hyperlink")).toHaveTextContent("tree");
      view.contentDOM.blur();
      expect(view.dom).not.toHaveClass("cm-lsp-hyperlink-cursor");
      view.contentDOM.focus(); hover();
      await Promise.resolve();
      expect(view.dom).toHaveClass("cm-lsp-hyperlink-cursor");
      view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true, button: 0 }));
      expect(onDefinition).toHaveBeenCalledWith({ line: 0, character: 2 });
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
      await Promise.resolve();
      expect(view.dom.querySelector(".cm-lsp-hyperlink")).toBeNull();
      hover(); window.dispatchEvent(new Event("blur"));
      view.destroy();
      const dispatch = vi.spyOn(view, "dispatch");
      await Promise.resolve();
      expect(dispatch).not.toHaveBeenCalled();
    } finally { position.mockRestore(); view.destroy(); view.dom.remove(); }
  });

  it("clears a real content blur during a panel transaction without nesting updates", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { EditorView, showPanel } = await import("@codemirror/view");
    const { createLspHyperlinkExtension } = await import("./lspHyperlink");
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener("error", onError);
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    const view = new EditorView({ parent: document.body, state: EditorState.create({
      doc: "tree", extensions: [createLspHyperlinkExtension({ onDefinition: () => true })],
    }) });
    try {
      view.contentDOM.focus();
      expect(view.hasFocus).toBe(true);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
      // Public CM panel lifecycle, real DOM focus/blur, no dispatch/focus mocks.
      // jsdom select() does not focus, so explicitly exercise the browser's blur boundary.
      const field = document.createElement("input");
      view.dispatch({ effects: (await import("@codemirror/state")).StateEffect.appendConfig.of(
        showPanel.of(() => ({ dom: field, mount: () => field.focus() })),
      ) });
      await Promise.resolve();
      expect(field).toHaveFocus();
      expect(errors).toEqual([]);
    } finally {
      view.destroy(); view.dom.remove();
      window.removeEventListener("error", onError); consoleError.mockRestore();
    }
  });

  it("re-validates the hover link after a doc change without dispatching inside update", async () => {
    // ED-AUDIT-007 native evidence: Ctrl+Z (Ctrl held) with the pointer over
    // the content crashed the plugin — update() dispatched into the running
    // transaction ("CodeMirror plugin crashed"). The refresh must defer out
    // of the update loop and still re-anchor the link on the new document.
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { createLspHyperlinkExtension } = await import("./lspHyperlink");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = new EditorView({
      state: EditorState.create({
        doc: "hello world",
        extensions: [createLspHyperlinkExtension({ onDefinition: async () => true })],
      }),
      parent: document.body,
    });
    const posAtCoords = vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(6);
    // Hover with Ctrl held: link over "world", cursor class on.
    view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    await Promise.resolve();
    expect(view.dom.className).toContain("cm-lsp-hyperlink-cursor");

    // Doc change while Ctrl is still held (the Ctrl+Z shape).
    const crashed = vi.fn();
    consoleError.mockImplementation((first: unknown, ...rest: unknown[]) => {
      if (String(first).includes("CodeMirror plugin crashed")) crashed(...rest);
    });
    view.dispatch({ changes: { from: 0, insert: "X" } });
    // Synchronous update phase must not dispatch (no crash logged).
    expect(crashed).not.toHaveBeenCalled();
    // The deferred refresh re-anchors the link to the identifier at the old
    // hover offset in the NEW document ("Xhello" → pos 6 lands on "hello").
    await Promise.resolve();
    await Promise.resolve();
    expect(crashed).not.toHaveBeenCalled();
    expect(view.dom.className).toContain("cm-lsp-hyperlink-cursor");
    posAtCoords.mockRestore();
    consoleError.mockRestore();
    view.destroy();
  });
});
