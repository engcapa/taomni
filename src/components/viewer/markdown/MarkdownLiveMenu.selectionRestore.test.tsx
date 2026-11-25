import { useRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeText } from "../../../lib/clipboard";
import { MarkdownLiveMenu } from "./MarkdownLiveMenu";

vi.mock("../../../lib/clipboard", () => ({ writeText: vi.fn(async () => undefined) }));

function Document() {
  const root = useRef<HTMLDivElement>(null);
  return <div ref={root}>
    <div className="fv-md-live-surface">
      <div className="cm-content" data-testid="surface" tabIndex={0}>
        <p>Rendered sentence</p><p>Second paragraph</p>
      </div>
    </div>
    <MarkdownLiveMenu root={root} enabled onError={vi.fn()} />
  </div>;
}

function selectRenderedSentence(): void {
  const paragraph = screen.getByText("Rendered sentence");
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  expect(selection.toString()).toBe("Rendered sentence");
}

function selectionText(): string {
  return window.getSelection()?.toString() ?? "";
}

// WebKit (WKWebView, WebKitGTK) collapses the document selection the moment
// the custom menu moves focus into itself. Chromium keeps it. Modelling the
// engine behavior here keeps the regression test meaningful in jsdom.
const originalFocus = HTMLElement.prototype.focus;
let engineClearsSelectionOnMenuFocus = true;
beforeEach(() => {
  engineClearsSelectionOnMenuFocus = true;
  HTMLElement.prototype.focus = function patchedFocus(this: HTMLElement, options?: FocusOptions) {
    originalFocus.call(this, options);
    if (engineClearsSelectionOnMenuFocus && this.closest?.('[data-testid="markdown-live-context-menu"]')) {
      window.getSelection()?.removeAllRanges();
    }
  };
});

afterEach(() => {
  HTMLElement.prototype.focus = originalFocus;
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
  cleanup();
});

it("restores the right-clicked range while the WebKit browse menu holds focus", async () => {
  render(<Document />);
  selectRenderedSentence();
  fireEvent.contextMenu(screen.getByText("Rendered sentence"));

  const menu = await screen.findByTestId("markdown-live-context-menu");
  expect(menu).toHaveFocus();
  await waitFor(() => expect(selectionText()).toBe("Rendered sentence"));

  // Copy still operates on exactly the text the menu captured.
  fireEvent.click(screen.getByTestId("markdown-live-copy-selection"));
  expect(writeText).toHaveBeenCalledWith("Rendered sentence");
  await waitFor(() => expect(screen.queryByTestId("markdown-live-context-menu")).toBeNull());
});

it("keeps the selection after Escape dismisses the menu", async () => {
  render(<Document />);
  selectRenderedSentence();
  fireEvent.contextMenu(screen.getByText("Rendered sentence"));
  await screen.findByTestId("markdown-live-context-menu");
  await waitFor(() => expect(selectionText()).toBe("Rendered sentence"));

  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByTestId("markdown-live-context-menu")).toBeNull());
  await waitFor(() => expect(selectionText()).toBe("Rendered sentence"));
});

it("does not resurrect the old range after an outside press or Select all", async () => {
  render(<Document />);
  selectRenderedSentence();
  fireEvent.contextMenu(screen.getByText("Rendered sentence"));
  await screen.findByTestId("markdown-live-context-menu");
  await waitFor(() => expect(selectionText()).toBe("Rendered sentence"));

  // A press outside the menu starts a new selection context; the browser clears
  // the range and the menu must not re-apply the captured one afterwards.
  window.getSelection()?.removeAllRanges();
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByTestId("markdown-live-context-menu")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(selectionText()).toBe("");

  selectRenderedSentence();
  fireEvent.contextMenu(screen.getByText("Rendered sentence"));
  await screen.findByTestId("markdown-live-context-menu");
  await waitFor(() => expect(selectionText()).toBe("Rendered sentence"));
  fireEvent.click(screen.getByTestId("markdown-live-select-all"));
  await waitFor(() => expect(screen.queryByTestId("markdown-live-context-menu")).toBeNull());
  expect(selectionText()).toContain("Rendered sentence");
  expect(selectionText()).toContain("Second paragraph");
});

it("leaves an already live selection untouched where the engine keeps it (Chromium)", async () => {
  engineClearsSelectionOnMenuFocus = false;
  render(<Document />);
  selectRenderedSentence();
  fireEvent.contextMenu(screen.getByText("Rendered sentence"));
  await screen.findByTestId("markdown-live-context-menu");
  expect(selectionText()).toBe("Rendered sentence");
  fireEvent.click(screen.getByTestId("markdown-live-copy-selection"));
  expect(writeText).toHaveBeenCalledWith("Rendered sentence");
});
