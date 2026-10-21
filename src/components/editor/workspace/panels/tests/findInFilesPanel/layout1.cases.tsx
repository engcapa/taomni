import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MATCHES_PER_FILE, FindInFilesPanel, matchSegments } from "../../FindInFilesPanel";
import { doneEvent, roots, runSearch, searchMatch, searchMocks } from "./harness";

export function registerFindInFilesPanelLayout1Cases() {

  describe("FindInFilesPanel", () => {
    afterEach(() => {
      cleanup();
      vi.clearAllMocks();
      vi.unstubAllGlobals();
    });

    beforeEach(() => {
      vi.stubGlobal("confirm", vi.fn(() => true));
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
      // Keyword hits use the dedicated find-match styling (not plain text-inherit).
      const hits = screen.getAllByTestId("code-workspace-find-match-hit");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].className).toContain("find-match-bg");

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

    it("focuses the query in the same commit that requests it (typing right after Ctrl+Shift+F)", () => {
      const { rerender } = render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);
      const query = screen.getByLabelText("Search query");
      expect(query).not.toHaveFocus();
      rerender(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} focusNonce={1} />);
      expect(query).toHaveFocus();
    });

    it("explains when there are no roots to search", () => {
      render(<FindInFilesPanel roots={[]} onOpenMatch={vi.fn()} />);
      expect(screen.getByText("Add a folder to the workspace to search its files")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Run search" })).toBeDisabled();
    });

    it("limits visible matches per file and expands on demand", async () => {
      render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);
      const emit = await runSearch();
      const many = Array.from({ length: DEFAULT_MATCHES_PER_FILE + 5 }, (_, index) =>
        searchMatch({
          lineNumber: index + 1,
          column: 1,
          matchStart: 0,
          matchEnd: 6,
          lineText: `needle at ${index + 1}`,
        }),
      );

      act(() => {
        emit({ ...doneEvent(), kind: "batch", matches: many });
        emit(doneEvent({ totalMatches: many.length }));
      });

      expect(screen.getAllByTestId("code-workspace-find-match-hit")).toHaveLength(DEFAULT_MATCHES_PER_FILE);
      expect(screen.getByTestId("code-workspace-find-file-count")).toHaveTextContent(
        `${DEFAULT_MATCHES_PER_FILE}/${many.length}`,
      );
      expect(screen.getByTestId("code-workspace-find-show-more")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("code-workspace-find-show-all"));
      expect(screen.getAllByTestId("code-workspace-find-match-hit")).toHaveLength(many.length);
      expect(screen.queryByTestId("code-workspace-find-show-more")).not.toBeInTheDocument();
      expect(screen.getByTestId("code-workspace-find-file-count")).toHaveTextContent(`${many.length}`);
    });

    it("collapses a file group without dropping the full replace set", async () => {
      const onReplaceMatches = vi.fn();
      render(
        <FindInFilesPanel
          roots={roots}
          onOpenMatch={vi.fn()}
          onReplaceMatches={onReplaceMatches}
        />,
      );
      const emit = await runSearch();
      const matches = [
        searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 }),
        searchMatch({ lineNumber: 2, lineText: "needle two", matchStart: 0, matchEnd: 6, column: 1 }),
        searchMatch({ path: "src/b.ts", lineNumber: 3, lineText: "needle three", matchStart: 0, matchEnd: 6, column: 1 }),
      ];

      act(() => {
        emit({ ...doneEvent(), kind: "batch", matches });
        emit(doneEvent({ totalMatches: matches.length }));
      });

      expect(screen.getAllByTestId("code-workspace-find-match-hit")).toHaveLength(3);
      fireEvent.click(screen.getByRole("button", { name: "Collapse app/src/a.ts" }));
      // Two matches in a.ts are hidden; b.ts remains.
      expect(screen.getAllByTestId("code-workspace-find-match-hit")).toHaveLength(1);

      // ED-FIND-004: replace opens a structured preview instead of a bare
      // confirm; the full result set (not just visible rows) is committed.
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
      expect(await screen.findByTestId("code-workspace-replace-preview")).toBeInTheDocument();
      expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("3 of 3");
    });

    it("applies editor-style syntax classes on result lines once the language loads", async () => {
      render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);
      const emit = await runSearch();

      act(() => {
        emit({
          ...doneEvent(),
          kind: "batch",
          matches: [searchMatch({ lineText: "const needle = 1;", matchStart: 6, matchEnd: 12, column: 7 })],
        });
        emit(doneEvent({ totalMatches: 1 }));
      });

      await waitFor(() => {
        const line = document.querySelector(".taomni-find-line");
        expect(line?.querySelector(".tok-keyword")).toBeTruthy();
      });
      expect(screen.getByTestId("code-workspace-find-match-hit")).toHaveTextContent("needle");
    });
  });

  describe("ED-PARITY-006: result exclusion, seeded preview and post-commit pruning", () => {
    afterEach(() => {
      cleanup();
      vi.clearAllMocks();
    });

    type ReplaceMatchesHandler = NonNullable<ComponentProps<typeof FindInFilesPanel>["onReplaceMatches"]>;

    async function emitParityResults(
      onReplaceMatches: ReplaceMatchesHandler = vi.fn(async () => ({ ok: true as const })),
    ) {
      render(
        <FindInFilesPanel
          roots={roots}
          onOpenMatch={vi.fn()}
          onReplaceMatches={onReplaceMatches}
        />,
      );
      const emit = await runSearch();
      const matches = [
        searchMatch({ lineNumber: 1, lineText: "alpha needle", matchStart: 6, matchEnd: 12, column: 7 }),
        searchMatch({ lineNumber: 2, lineText: "beta needle", matchStart: 5, matchEnd: 11, column: 6 }),
        searchMatch({ path: "src/b.ts", lineNumber: 1, lineText: "gamma needle", matchStart: 6, matchEnd: 12, column: 7 }),
      ];
      act(() => {
        emit({ ...doneEvent(), kind: "batch", matches });
        emit(doneEvent({ totalMatches: matches.length }));
      });
      return { matches, onReplaceMatches };
    }

    it("ED-PARITY-006 Delete on a focused result row toggles exclusion and moves focus", async () => {
      await emitParityResults();
      const rows = screen.getAllByTestId("code-workspace-find-match-row");
      rows[1]?.focus();
      fireEvent.keyDown(rows[1]!, { key: "Delete" });

      expect(rows[1]).toHaveAttribute("data-excluded", "true");
      expect(document.activeElement).toBe(rows[2]);
      expect(screen.getAllByTestId("code-workspace-find-file-count")[0]).toHaveTextContent("2");

      fireEvent.keyDown(rows[2]!, { key: "Delete" });
      expect(rows[2]).toHaveAttribute("data-excluded", "true");
      rows[1]?.focus();
      fireEvent.keyDown(rows[1]!, { key: "Delete" });
      expect(rows[1]).toHaveAttribute("data-excluded", "false");
    });

    it("ED-PARITY-006 Delete on a file header toggles every row of that file", async () => {
      await emitParityResults();
      const header = screen.getByRole("button", { name: "Collapse app/src/a.ts" });
      fireEvent.keyDown(header, { key: "Delete" });
      expect(screen.getAllByTestId("code-workspace-find-match-row")[0]).toHaveAttribute("data-excluded", "true");
      expect(screen.getAllByTestId("code-workspace-find-match-row")[1]).toHaveAttribute("data-excluded", "true");
      expect(screen.getAllByTestId("code-workspace-find-match-row")[2]).toHaveAttribute("data-excluded", "false");
      fireEvent.keyDown(header, { key: "Delete" });
      expect(screen.getAllByTestId("code-workspace-find-match-row")[0]).toHaveAttribute("data-excluded", "false");
      expect(screen.getAllByTestId("code-workspace-find-match-row")[1]).toHaveAttribute("data-excluded", "false");
    });

    it("ED-PARITY-006 context menu Exclude and Restore mirror Delete", async () => {
      await emitParityResults();
      const row = screen.getAllByTestId("code-workspace-find-match-row")[1]!;
      fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
      fireEvent.click(screen.getByTestId("code-workspace-find-row-exclude"));
      expect(row).toHaveAttribute("data-excluded", "true");
      fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
      fireEvent.click(screen.getByTestId("code-workspace-find-row-restore"));
      expect(row).toHaveAttribute("data-excluded", "false");
    });

    it("ED-PARITY-006 Delete inside the query input edits text only", async () => {
      await emitParityResults();
      const input = screen.getByLabelText("Search query") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "needl" } });
      input.focus();
      fireEvent.keyDown(input, { key: "Delete" });
      expect(input.value).toBe("needl");
      expect(screen.getAllByTestId("code-workspace-find-match-row").every((row) => row.getAttribute("data-excluded") === "false")).toBe(true);
    });

    it("ED-PARITY-006 a new search clears exclusions while collapse preserves them", async () => {
      await emitParityResults();
      const row = screen.getAllByTestId("code-workspace-find-match-row")[1]!;
      fireEvent.keyDown(row, { key: "Delete" });
      fireEvent.click(screen.getByRole("button", { name: "Collapse app/src/a.ts" }));
      fireEvent.click(screen.getByRole("button", { name: "Expand app/src/a.ts" }));
      expect(screen.getAllByTestId("code-workspace-find-match-row")[1]).toHaveAttribute("data-excluded", "true");
      const emit = await runSearch("next");
      act(() => {
        emit({ ...doneEvent({ searchId: "search-1", totalMatches: 1 }), kind: "batch", matches: [searchMatch()] });
        emit(doneEvent({ searchId: "search-1", totalMatches: 1 }));
      });
      expect(screen.getAllByTestId("code-workspace-find-match-row")[0]).toHaveAttribute("data-excluded", "false");
    });

    it("ED-PARITY-006 Replace All is disabled when every result is excluded", async () => {
      const { onReplaceMatches } = await emitParityResults();
      for (const row of screen.getAllByTestId("code-workspace-find-match-row")) {
        fireEvent.keyDown(row, { key: "Delete" });
      }
      const replaceAll = screen.getByRole("button", { name: "Preview replace all matches" });
      expect(replaceAll).toBeDisabled();
      expect(onReplaceMatches).not.toHaveBeenCalled();
    });

    it("ED-PARITY-006 Replace All seeds exclusions and prunes committed rows", async () => {
      const { onReplaceMatches } = await emitParityResults();
      const rows = screen.getAllByTestId("code-workspace-find-match-row");
      rows[1]?.focus();
      fireEvent.keyDown(rows[1]!, { key: "Delete" });
      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "coin" } });
      expect(screen.getByRole("button", { name: "Preview replace all matches" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));

      const excludedCheckboxes = await screen.findAllByTestId("code-workspace-replace-usage");
      expect(excludedCheckboxes.some((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
      expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("2 of 3");

      fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));
      await waitFor(() => expect(onReplaceMatches).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getAllByTestId("code-workspace-find-match-row")).toHaveLength(1));
      expect(screen.getByTestId("code-workspace-find-match-row")).toHaveAttribute("data-excluded", "true");
      expect(screen.getByTestId("code-workspace-find-replaced-notice")).toHaveTextContent("Replaced 2 occurrences in 2 files");
    });

    it("ED-PARITY-006 failed commit keeps the result list unchanged", async () => {
      const { onReplaceMatches } = await emitParityResults(vi.fn(async () => ({
        ok: false as const,
        message: "Replace blocked: changed on disk",
      })));
      const rows = screen.getAllByTestId("code-workspace-find-match-row");
      fireEvent.keyDown(rows[1]!, { key: "Delete" });
      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "coin" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
      fireEvent.click(await screen.findByTestId("code-workspace-replace-commit"));
      expect(await screen.findByTestId("code-workspace-replace-commit-error")).toHaveTextContent("changed on disk");
      expect(screen.getAllByTestId("code-workspace-find-match-row")).toHaveLength(3);
      expect(screen.getAllByTestId("code-workspace-find-match-row")[1]).toHaveAttribute("data-excluded", "true");
      expect(onReplaceMatches).toHaveBeenCalledTimes(1);
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
}
