import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openFile } from "../../lib/openFile";
import { useChatFileLinks } from "./useChatFileLinks";

vi.mock("../../lib/openFile", () => ({ openFile: vi.fn(async () => "viewer") }));
vi.mock("../../lib/fileOpenContext", () => ({ fileOpenWorkspaceForTab: () => undefined }));

function Message({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useChatFileLinks(ref, true, content);
  return <div ref={ref}><div data-chat-richtext="true" dangerouslySetInnerHTML={{ __html: content }} /></div>;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());
it("opens local file chips from prose and inline code without hijacking external links", async () => {
  render(<Message content={'<p>Generated /tmp/report.html and <code>/tmp/notes.md:7</code>.</p><a href="https://example.test/a.txt">External</a>'} />);
  const chips = screen.getAllByTestId("ai-file-link");
  expect(chips).toHaveLength(2);
  fireEvent.click(chips[0]);
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith({ path: "/tmp/report.html" }, { context: "ai-file-link", workspaceId: undefined, line: undefined }));
  fireEvent.keyDown(chips[1], { key: "Enter" });
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith({ path: "/tmp/notes.md" }, { context: "ai-file-link", workspaceId: undefined, line: 7 }));
  expect(screen.getByText("External")).not.toHaveAttribute("data-file-path");
});
it("reconciles streaming HTML replacements and cleans up chip listeners on unmount", async () => {
  const view = render(<Message content={'<p>/tmp/one.md</p>'} />);
  const old = screen.getByTestId("ai-file-link");
  view.rerender(<Message content={'<p>/tmp/two.md</p>'} />);
  expect(screen.getAllByTestId("ai-file-link")).toHaveLength(1);
  fireEvent.click(screen.getByTestId("ai-file-link"));
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith({ path: "/tmp/two.md" }, expect.anything()));
  view.unmount();
  vi.mocked(openFile).mockClear();
  fireEvent.click(old);
  expect(openFile).not.toHaveBeenCalled();
});
