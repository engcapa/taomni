import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";
import { WorkspaceActionHost } from "./workspaceActionHost";
import type { OpenFileState } from "./codeWorkspaceModel";

const calls = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("./model/mermaid", () => ({ renderMermaid: calls.render }));
vi.mock("./codeWorkspaceModel", () => ({ hashString: (value: string) => value.length,
  errorMessage: String, exportMermaidPng: vi.fn(), exportMermaidSvg: vi.fn() }));

afterEach(() => { cleanup(); delete document.documentElement.dataset.appTheme; vi.clearAllMocks(); });

it("keeps search marks, scroll and the completed diagram while changing only preview appearance", async () => {
  document.documentElement.dataset.appTheme = "light";
  let finish!: (value: { svg: string }) => void;
  calls.render.mockResolvedValueOnce({ svg: '<svg data-theme="light"><text>Diagram</text></svg>' })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const file = { key: "note.md", title: "note.md", text: "# Needle\n\nNeedle text\n\n```mermaid\nflowchart LR\nA-->B\n```" } as OpenFileState;
  const host = new WorkspaceActionHost({ workspaceId: "preview-appearance",
    getDefaultContext: () => ({ focus: "editor", hasActiveFile: true, editorViewId: "primary" }) });
  render(<MarkdownPreview file={file} onOpenHref={() => false} searchOwner={{ actionHost: host, groupId: "primary", standalone: true }} />);
  const root = screen.getByTestId("code-workspace-markdown-preview");
  await waitFor(() => expect(root.querySelector('svg[data-theme="light"]')).not.toBeNull());
  await act(async () => { await host.execute("editor.find"); });
  fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "needle" } });
  expect(screen.getByTestId("markdown-search-count")).toHaveTextContent("1/2");
  const marks = screen.getAllByTestId("markdown-search-match");
  root.scrollTop = 90;
  fireEvent.click(screen.getByTestId("markdown-preview-appearance"));
  fireEvent.click(screen.getByRole("option", { name: "Dark" }));
  expect(calls.render).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), "dark");
  expect(root.querySelector('svg[data-theme="light"]')).not.toBeNull();
  expect(root.scrollTop).toBe(90);
  await act(async () => { finish({ svg: '<svg data-theme="dark"><text>Diagram</text></svg>' }); });
  expect(root.querySelector('svg[data-theme="dark"]')).not.toBeNull();
  expect(screen.getAllByTestId("markdown-search-match")).toEqual(marks);
  expect(screen.getByTestId("markdown-search-count")).toHaveTextContent("1/2");
  expect(root.scrollTop).toBe(90);
  expect(document.documentElement.dataset.appTheme).toBe("light");
  host.dispose();
});
