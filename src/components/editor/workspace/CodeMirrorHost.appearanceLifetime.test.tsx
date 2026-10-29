import { act, cleanup } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { renderEditor } from "./tests/codeMirrorHost/harness";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const appearance = {
  fontFamily: "monospace", fontSizePx: 14, lineHeight: 1.5,
  ligatures: false, colorSchemeId: "app", highContrast: false,
};

function observeEditorStyles() {
  const writes: MutationRecord[] = [];
  const observer = new MutationObserver((records) => writes.push(...records.filter((record) => {
    const style = record.target instanceof HTMLStyleElement ? record.target : record.target.parentElement;
    return style?.tagName === "STYLE" && style.textContent?.includes(".cm-");
  })));
  observer.observe(document.head, { childList: true, characterData: true, subtree: true });
  return { writes, disconnect: () => observer.disconnect() };
}

it("switches documents with equal appearance without rewriting the document stylesheet", async () => {
  const rendered = renderEditor("first", vi.fn(), { fileKey: "a", path: "a.txt", appearance });
  await act(async () => { await Promise.resolve(); });
  const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const themeClasses = view.dom.className;
  const styles = observeEditorStyles();
  try {
    rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="b" path="b.txt" doc="second" appearance={{ ...appearance }} />);
    expect(view.state.doc.toString()).toBe("second");
    rendered.rerender(<CodeMirrorHost {...rendered.props} />);
    await act(async () => { await Promise.resolve(); });
    expect(view.state.doc.toString()).toBe("first");
    expect(view.dom.className).toBe(themeClasses);
    expect(styles.writes).toHaveLength(0);
  } finally {
    styles.disconnect();
  }
});

it("shares styles across editor panes and still applies changed appearance to a cached document", async () => {
  const first = renderEditor("first", vi.fn(), { fileKey: "a", path: "a.txt", appearance });
  await act(async () => { await Promise.resolve(); });
  const view = EditorView.findFromDOM(first.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const initialClasses = view.dom.className;
  const styles = observeEditorStyles();
  try {
    const second = renderEditor("other pane", vi.fn(), { fileKey: "c", path: "c.txt", appearance: { ...appearance } });
    await act(async () => { await Promise.resolve(); });
    expect(second.container.querySelector(".cm-editor")?.className).toBe(initialClasses);
    expect(styles.writes).toHaveLength(0);
    first.rerender(<CodeMirrorHost {...first.props} fileKey="b" path="b.txt" doc="second" />);
    const changed = { ...appearance, fontSizePx: 19, ligatures: true, highContrast: true };
    first.rerender(<CodeMirrorHost {...first.props} fileKey="b" path="b.txt" doc="second" appearance={changed} />);
    first.rerender(<CodeMirrorHost {...first.props} appearance={changed} />);
    await act(async () => { await Promise.resolve(); });
    expect(view.state.doc.toString()).toBe("first");
    expect(view.contentDOM).toHaveAttribute("data-editor-color-scheme", "high-contrast");
    expect(view.contentDOM).toHaveAttribute("data-editor-ligatures", "true");
    expect(view.dom.className).not.toBe(initialClasses);
    expect(second.container.querySelector(".cm-content")).toHaveAttribute("data-editor-color-scheme", "app");
    expect(styles.writes.length).toBeGreaterThan(0);
  } finally {
    styles.disconnect();
  }
});

it("reattaches the editor stylesheet when a host removes it", async () => {
  const rendered = renderEditor("first", vi.fn(), { fileKey: "a", path: "a.txt", appearance });
  await act(async () => { await Promise.resolve(); });
  const style = [...document.head.querySelectorAll("style")].find((element) => element.textContent?.includes(".cm-scroller"))!;
  expect(style).toBeDefined();
  style.remove();
  rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="b" path="b.txt" doc="second" />);
  expect(style.isConnected).toBe(true);
  expect(rendered.container.querySelector(".cm-content")).toHaveTextContent("second");
});
