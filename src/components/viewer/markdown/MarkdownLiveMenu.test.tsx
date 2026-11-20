import { useRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { writeText } from "../../../lib/clipboard";
import { MarkdownLiveMenu } from "./MarkdownLiveMenu";

vi.mock("../../../lib/clipboard", () => ({ writeText: vi.fn(async () => undefined) }));

function Document({ enabled = true }: { enabled?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  return <div ref={root}>
    <div className="fv-md-live-surface">
      <div className="cm-content" tabIndex={0}><p>Rendered sentence</p><p>Second paragraph</p></div>
    </div>
    <MarkdownLiveMenu root={root} enabled={enabled} onError={vi.fn()} />
  </div>;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
  cleanup();
});

it("copies the selection captured at the right click and keeps copy disabled with no selection", async () => {
  render(<Document />);
  const sentence = screen.getByText("Rendered sentence");
  fireEvent.contextMenu(sentence);
  expect(screen.getByTestId("markdown-live-copy-selection")).toBeDisabled();
  fireEvent.click(screen.getByTestId("markdown-live-select-all"));
  expect(window.getSelection()?.toString()).toContain("Rendered sentence");
  fireEvent.contextMenu(sentence);
  fireEvent.click(screen.getByTestId("markdown-live-copy-selection"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Second paragraph")));
  expect(screen.queryByTestId("markdown-live-context-menu")).toBeNull();
});

it("removes the browse menu when editing takes ownership", () => {
  const { rerender } = render(<Document />);
  fireEvent.contextMenu(screen.getByText("Rendered sentence"));
  expect(screen.getByTestId("markdown-live-context-menu")).toBeVisible();
  rerender(<Document enabled={false} />);
  fireEvent.contextMenu(screen.getByText("Rendered sentence"));
  expect(screen.queryByTestId("markdown-live-context-menu")).toBeNull();
});
