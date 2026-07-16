import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceSearchEvent,
  WorkspaceSearchMatch,
} from "../../../../lib/editor/workspaceSearch";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { FindInFilesPanel, matchSegments } from "./FindInFilesPanel";

const searchMocks = vi.hoisted(() => ({
  newWorkspaceSearchId: vi.fn(() => "search-1"),
  subscribeWorkspaceSearch: vi.fn(),
  workspaceSearchStart: vi.fn(),
  workspaceSearchCancel: vi.fn(async () => true),
}));

vi.mock("../../../../lib/editor/workspaceSearch", () => searchMocks);

const roots: CodeWorkspaceRootInfo[] = [
  { id: "root-1", name: "app", path: "C:/repo/app", kind: "git" },
];

function searchMatch(overrides: Partial<WorkspaceSearchMatch> = {}): WorkspaceSearchMatch {
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

function doneEvent(overrides: Partial<WorkspaceSearchEvent> = {}): WorkspaceSearchEvent {
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

async function runSearch(query = "needle"): Promise<(event: WorkspaceSearchEvent) => void> {
  const unlisten = vi.fn();
  searchMocks.subscribeWorkspaceSearch.mockResolvedValue(unlisten);
  searchMocks.workspaceSearchStart.mockResolvedValue("search-1");

  const input = screen.getByLabelText("Search query");
  fireEvent.change(input, { target: { value: query } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(searchMocks.workspaceSearchStart).toHaveBeenCalled());
  return searchMocks.subscribeWorkspaceSearch.mock.calls.at(-1)![1];
}

describe("FindInFilesPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("subscribes before starting and streams grouped results", async () => {
    const onOpenMatch = vi.fn();
    render(<FindInFilesPanel roots={roots} onOpenMatch={onOpenMatch} />);

    const emit = await runSearch();

    expect(searchMocks.subscribeWorkspaceSearch.mock.invocationCallOrder[0])
      .toBeLessThan(searchMocks.workspaceSearchStart.mock.invocationCallOrder[0]);
    expect(searchMocks.workspaceSearchStart).toHaveBeenCalledWith(
      "search-1",
      [{ id: "root-1", name: "app", path: "C:/repo/app" }],
      "needle",
      expect.objectContaining({ caseSensitive: false, wholeWord: false, regexp: false }),
    );

    act(() => {
      emit({
        ...doneEvent(),
        kind: "batch",
        matches: [
          searchMatch(),
          searchMatch({ lineNumber: 20, column: 1, matchStart: 0, matchEnd: 6, lineText: "needle();" }),
          searchMatch({ path: "src/b.ts", lineText: "let needle = 2;", matchStart: 4, matchEnd: 10, column: 5 }),
        ],
      });
      emit(doneEvent());
    });

    expect(screen.getByText("app/src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("app/src/b.ts")).toBeInTheDocument();
    expect(screen.getByText("3 results · 2 files")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /12:7/ }));
    expect(onOpenMatch).toHaveBeenCalledWith(searchMatch(), { preview: true });

    fireEvent.doubleClick(screen.getByTitle("app/src/a.ts:12:7"));
    expect(onOpenMatch).toHaveBeenLastCalledWith(searchMatch(), { preview: false });
  });

  it("passes search options and globs through to the backend", async () => {
    render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    fireEvent.click(screen.getByRole("button", { name: "Regular expression" }));
    fireEvent.change(screen.getByLabelText("Include globs"), { target: { value: "*.ts, src/**" } });
    fireEvent.change(screen.getByLabelText("Exclude globs"), { target: { value: "dist/**" } });
    await runSearch("nee.le");

    expect(searchMocks.workspaceSearchStart).toHaveBeenCalledWith(
      "search-1",
      expect.anything(),
      "nee.le",
      expect.objectContaining({
        caseSensitive: true,
        regexp: true,
        includeGlobs: ["*.ts", "src/**"],
        excludeGlobs: ["dist/**"],
      }),
    );
  });

  it("cancels a running search and reports partial results", async () => {
    render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);
    const emit = await runSearch();

    fireEvent.click(screen.getByRole("button", { name: "Cancel search" }));
    expect(searchMocks.workspaceSearchCancel).toHaveBeenCalledWith("search-1");

    act(() => emit(doneEvent({ cancelled: true, totalMatches: 1 })));
    expect(screen.getByText(/Search cancelled/)).toBeInTheDocument();
  });

  it("reports truncation and backend errors", async () => {
    render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);
    let emit = await runSearch();
    act(() => emit(doneEvent({ truncated: true })));
    expect(screen.getByText(/Match limit reached/)).toBeInTheDocument();

    emit = await runSearch("other");
    act(() => emit(doneEvent({ kind: "error", error: "Invalid search pattern: boom" })));
    expect(screen.getByText("Invalid search pattern: boom")).toBeInTheDocument();
  });

  it("explains when there are no roots to search", () => {
    render(<FindInFilesPanel roots={[]} onOpenMatch={vi.fn()} />);
    expect(screen.getByText("Add a folder to the workspace to search its files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run search" })).toBeDisabled();
  });
});

describe("matchSegments", () => {
  it("trims leading whitespace and keeps the match highlighted", () => {
    const segments = matchSegments(searchMatch({
      lineText: "    const needle = 1;",
      matchStart: 10,
      matchEnd: 16,
    }));
    expect(segments.before).toBe("const ");
    expect(segments.hit).toBe("needle");
    expect(segments.after).toBe(" = 1;");
    expect(segments.elidedStart).toBe(false);
    expect(segments.elidedEnd).toBe(false);
    expect(segments.text).toBe("const needle = 1;");
    expect(segments.hitStart).toBe(6);
    expect(segments.hitEnd).toBe(12);
  });

  it("elides long prefixes ahead of the match", () => {
    const prefix = "x".repeat(80);
    const segments = matchSegments(searchMatch({
      lineText: `${prefix}needle`,
      matchStart: 80,
      matchEnd: 86,
    }));
    expect(segments.before.startsWith("…")).toBe(true);
    expect(segments.hit).toBe("needle");
    expect(segments.elidedStart).toBe(true);
    // Default CONTEXT_BEFORE_MATCH is 48 when after-side is empty.
    expect(Array.from(segments.text).length).toBeLessThanOrEqual(120);
    expect(segments.before).toBe(`…${"x".repeat(48)}`);
  });

  it("elides long suffixes after the match", () => {
    const suffix = "y".repeat(100);
    const segments = matchSegments(searchMatch({
      lineText: `needle${suffix}`,
      matchStart: 0,
      matchEnd: 6,
    }));
    expect(segments.hit).toBe("needle");
    expect(segments.after.endsWith("…")).toBe(true);
    expect(segments.elidedEnd).toBe(true);
    expect(Array.from(segments.text).length).toBeLessThanOrEqual(120);
  });

  it("keeps the full hit when the line is long on both sides", () => {
    const left = "L".repeat(80);
    const right = "R".repeat(80);
    const segments = matchSegments(searchMatch({
      lineText: `${left}HIT${right}`,
      matchStart: 80,
      matchEnd: 83,
    }));
    expect(segments.hit).toBe("HIT");
    expect(segments.elidedStart).toBe(true);
    expect(segments.elidedEnd).toBe(true);
    expect(Array.from(segments.text).length).toBeLessThanOrEqual(120);
    expect(segments.text.includes("HIT")).toBe(true);
  });

  it("slices by code points so CJK offsets stay aligned", () => {
    const segments = matchSegments(searchMatch({
      lineText: "变量 needle 结束",
      matchStart: 3,
      matchEnd: 9,
    }));
    expect(segments.hit).toBe("needle");
    expect(segments.after).toBe(" 结束");
  });
});
