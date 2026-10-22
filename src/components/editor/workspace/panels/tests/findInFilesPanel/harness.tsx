import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import type { WorkspaceSearchEvent, WorkspaceSearchMatch } from "../../../../../../lib/editor/workspaceSearch";
import type { CodeWorkspaceRootInfo } from "../../../../../../types";

const searchMocks = vi.hoisted(() => ({
  newWorkspaceSearchId: vi.fn(() => "search-1"),
  subscribeWorkspaceSearch: vi.fn(),
  workspaceSearchStart: vi.fn(),
  workspaceSearchCancel: vi.fn(async () => true),
}));

vi.mock("../../../../../../lib/editor/workspaceSearch", () => searchMocks);

export const roots: CodeWorkspaceRootInfo[] = [
  { id: "root-1", name: "app", path: "C:/repo/app", kind: "git" },
];

export function searchMatch(overrides: Partial<WorkspaceSearchMatch> = {}): WorkspaceSearchMatch {
  return {
    rootId: "root-1",
    rootName: "app",
    rootPath: "C:/repo/app",
    path: "src/a.ts",
    lineNumber: 12,
    column: 7,
    matchStart: 6,
    matchEnd: 12,
    lineText: "const needle = 1;",
    ...overrides,
  };
}

export function doneEvent(overrides: Partial<WorkspaceSearchEvent> = {}): WorkspaceSearchEvent {
  return {
    searchId: "search-1",
    kind: "done",
    matches: [],
    truncated: false,
    cancelled: false,
    filesScanned: 4,
    totalMatches: 3,
    error: null,
    ...overrides,
  };
}

export async function runSearch(query = "needle"): Promise<(event: WorkspaceSearchEvent) => void> {
  const unlisten = vi.fn();
  searchMocks.subscribeWorkspaceSearch.mockResolvedValue(unlisten);
  searchMocks.workspaceSearchStart.mockResolvedValue("search-1");

  const input = screen.getByLabelText("Search query");
  fireEvent.change(input, { target: { value: query } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(searchMocks.workspaceSearchStart).toHaveBeenCalled());
  return searchMocks.subscribeWorkspaceSearch.mock.calls.at(-1)![1];
}

export { searchMocks };
