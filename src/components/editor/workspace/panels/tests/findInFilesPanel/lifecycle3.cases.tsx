import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LspWorkspaceEdit } from "../../../../../../lib/editor/lsp";
import type { WorkspaceSearchMatch } from "../../../../../../lib/editor/workspaceSearch";
import type { CodeWorkspaceRootInfo } from "../../../../../../types";
import { applyLspTextEditsToString } from "../../../lspTextEdits";
import { FindInFilesPanel } from "../../FindInFilesPanel";
import { doneEvent, roots, runSearch, searchMatch, searchMocks } from "./harness";

export interface registerFindInFilesPanelLifecycle3CasesContext {
  openPreview: (onReplaceMatches: (matches: WorkspaceSearchMatch[], replacement: string, edit: LspWorkspaceEdit) => Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string; }>) => Promise<WorkspaceSearchMatch[]>;
}

export function registerFindInFilesPanelLifecycle3Cases(caseContext: registerFindInFilesPanelLifecycle3CasesContext) {

  it("commits the filtered set and closes on success (A1/A3)", async () => {
    const onReplaceMatches = vi.fn(
      async (
        _matches: WorkspaceSearchMatch[],
        _replacement: string,
        _edit: LspWorkspaceEdit,
      ): Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string; }> =>
        ({ ok: true as const, appliedCount: 1, fileCount: 1 }),
    );
    await caseContext.openPreview(onReplaceMatches);

    // Exclude the b.ts occurrence; only a.ts remains.
    fireEvent.click(screen.getByLabelText("Include occurrence at C:/repo/app/src/b.ts:3"));
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("1 of 2");
    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

    await waitFor(() => expect(onReplaceMatches).toHaveBeenCalledTimes(1));
    const call = onReplaceMatches.mock.calls[0];
    if (!call) throw new Error("expected onReplaceMatches to have been called");
    const [filtered, replacement, edit] = call;
    if (!filtered || replacement === undefined || !edit) {
      throw new Error("expected commit arguments");
    }
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe("src/a.ts");
    expect(replacement).toBe("thread");
    expect(edit.documentEdits).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId("code-workspace-replace-preview")).not.toBeInTheDocument());
  });

  it("commits UTF-16 ranges for a match after an astral prefix (ED-IMPROVE-004 A1)", async () => {
    const onReplaceMatches = vi.fn(
      async (
        _matches: WorkspaceSearchMatch[],
        _replacement: string,
        _edit: LspWorkspaceEdit,
      ): Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; }> =>
        ({ ok: true as const, appliedCount: 1, fileCount: 1 }),
    );
    render(
      <FindInFilesPanel
        roots={roots}
        onOpenMatch={vi.fn()}
        onReplaceMatches={onReplaceMatches}
      />,
    );
    const emit = await runSearch();
    const lineText = "const s = \"\u{1F600}foo\";";
    const matches = [
      searchMatch({ lineNumber: 1, lineText, matchStart: 12, matchEnd: 15, column: 13 }),
    ];
    act(() => {
      emit({ ...doneEvent(), kind: "batch", matches });
      emit(doneEvent({ totalMatches: matches.length }));
    });
    fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "bar" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
    expect(await screen.findByTestId("code-workspace-replace-preview")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

    await waitFor(() => expect(onReplaceMatches).toHaveBeenCalledTimes(1));
    const call = onReplaceMatches.mock.calls[0];
    if (!call) throw new Error("expected commit arguments");
    const edit = call[2];
    expect(edit.documentEdits).toHaveLength(1);
    expect(edit.documentEdits[0]!.edits[0]!.range).toEqual({
      start: { line: 0, character: 13 },
      end: { line: 0, character: 16 },
    });
    const next = applyLspTextEditsToString(lineText, edit.documentEdits[0]!.edits);
    expect(next).toBe("const s = \"\u{1F600}bar\";");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(next)).toBe(false);
  });

  it("commits the replacement frozen at preview time when the input changes later (ED-IMPROVE-005 A1)", async () => {
    const onReplaceMatches = vi.fn(
      async (
        _matches: WorkspaceSearchMatch[],
        _replacement: string,
        _edit: LspWorkspaceEdit,
      ): Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; }> =>
        ({ ok: true as const, appliedCount: 2, fileCount: 2 }),
    );
    await caseContext.openPreview(onReplaceMatches);

    // The user edits the replacement input after the preview froze its plan.
    fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "changed-later" } });
    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

    await waitFor(() => expect(onReplaceMatches).toHaveBeenCalledTimes(1));
    const call = onReplaceMatches.mock.calls[0];
    if (!call) throw new Error("expected commit arguments");
    const [, replacement, edit] = call;
    expect(replacement).toBe("thread");
    expect(edit.documentEdits[0]!.edits[0]!.newText).toBe("thread");
  });

  it("shows the frozen scope identity captured before the preview (ED-IMPROVE-005 A1)", async () => {
    await caseContext.openPreview(vi.fn(async () => ({ ok: true as const })));
    const scope = screen.getByTestId("code-workspace-replace-scope");
    expect(scope).toHaveTextContent("Frozen preview: project");
    expect(scope).toHaveTextContent("query “needle”");
  });

  it("keeps the frozen scope and set when query/scope inputs change after the preview opens (ED-IMPROVE-005 A1)", async () => {
    const onReplaceMatches = vi.fn(
      async (
        _matches: WorkspaceSearchMatch[],
        _replacement: string,
        _edit: LspWorkspaceEdit,
      ): Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; }> =>
        ({ ok: true as const, appliedCount: 2, fileCount: 2 }),
    );
    await caseContext.openPreview(onReplaceMatches);

    // Live UI inputs move after the freeze; the frozen snapshot must still
    // drive the scope label, the replacement and the committed match set.
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "other-query" } });
    fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "changed-later" } });
    fireEvent.change(screen.getByLabelText("Include globs"), { target: { value: "*.md" } });
    expect(screen.getByTestId("code-workspace-replace-scope")).toHaveTextContent("query “needle”");
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("2 of 2");

    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));
    await waitFor(() => expect(onReplaceMatches).toHaveBeenCalledTimes(1));
    const call = onReplaceMatches.mock.calls[0];
    if (!call) throw new Error("expected commit arguments");
    const [filtered, replacement, edit] = call;
    expect(filtered).toHaveLength(2);
    expect(replacement).toBe("thread");
    expect(edit.documentEdits[0]!.edits[0]!.newText).toBe("thread");
  });

  it("captures frozen preimages before the preview and passes them to the commit (ED-MAIN-005)", async () => {
    const onReplaceMatches = vi.fn(
      async (
        _matches: WorkspaceSearchMatch[],
        _replacement: string,
        _edit: LspWorkspaceEdit,
        _snapshot: unknown,
      ): Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; }> =>
        ({ ok: true as const, appliedCount: 2, fileCount: 2 }),
    );
    const onPrepareReplacePreimages = vi.fn(async (paths: readonly string[]) =>
      paths.map((path) => ({
        path,
        uri: `file://${path}`,
        textHash: `hash:${path}`,
        encoding: "UTF-8",
        bom: false,
        eol: "lf" as const,
        bufferRevision: 1,
        dirty: false,
        readOnly: false,
        workspaceInstanceId: "ws",
      })),
    );
    render(
      <FindInFilesPanel
        roots={roots}
        onOpenMatch={vi.fn()}
        onReplaceMatches={onReplaceMatches}
        onPrepareReplacePreimages={onPrepareReplacePreimages}
      />,
    );
    const emit = await runSearch();
    const matches = [
      searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 }),
      searchMatch({ path: "src/b.ts", lineNumber: 3, lineText: "needle three", matchStart: 0, matchEnd: 6, column: 1 }),
    ];
    act(() => {
      emit({ ...doneEvent(), kind: "batch", matches });
      emit(doneEvent({ totalMatches: matches.length }));
    });
    fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
    expect(await screen.findByTestId("code-workspace-replace-preview")).toBeInTheDocument();
    expect(onPrepareReplacePreimages).toHaveBeenCalledTimes(1);
    expect(onPrepareReplacePreimages.mock.calls[0]![0]).toHaveLength(2);

    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));
    await waitFor(() => expect(onReplaceMatches).toHaveBeenCalledTimes(1));
    const snapshot = onReplaceMatches.mock.calls[0]![3] as {
      preimages?: Array<{ textHash: string; eol: string; }>;
    };
    expect(snapshot.preimages).toHaveLength(2);
    expect(snapshot.preimages?.[0]?.textHash).toContain("hash:");
    expect(snapshot.preimages?.[0]?.eol).toBe("lf");
  });

  it("shows a preimage prepare failure and commits nothing (ED-MAIN-005)", async () => {
    const onReplaceMatches = vi.fn();
    const onPrepareReplacePreimages = vi.fn(async () => {
      throw new Error("cannot read src/b.ts");
    });
    render(
      <FindInFilesPanel
        roots={roots}
        onOpenMatch={vi.fn()}
        onReplaceMatches={onReplaceMatches}
        onPrepareReplacePreimages={onPrepareReplacePreimages}
      />,
    );
    const emit = await runSearch();
    const matches = [
      searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 }),
      searchMatch({ path: "src/b.ts", lineNumber: 3, lineText: "needle three", matchStart: 0, matchEnd: 6, column: 1 }),
    ];
    act(() => {
      emit({ ...doneEvent(), kind: "batch", matches });
      emit(doneEvent({ totalMatches: matches.length }));
    });
    fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
    expect(await screen.findByTestId("code-workspace-replace-error"))
      .toHaveTextContent("cannot read src/b.ts");
    expect(screen.queryByTestId("code-workspace-replace-preview")).not.toBeInTheDocument();
    expect(onReplaceMatches).not.toHaveBeenCalled();
  });

  it("keeps the preview open and shows the blocker message on conflict (A2)", async () => {
    const onReplaceMatches = vi.fn(
      async () => ({ ok: false as const, message: "Replace blocked: dirty buffer" }),
    );
    await caseContext.openPreview(onReplaceMatches);

    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));
    expect(await screen.findByTestId("code-workspace-replace-commit-error")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-replace-commit-error")).toHaveTextContent("dirty buffer");
    // Zero commit: the dialog stays open for correction or cancel.
    expect(screen.getByTestId("code-workspace-replace-preview")).toBeInTheDocument();
    expect(onReplaceMatches).toHaveBeenCalledTimes(1);
  });

  it("cancels with Escape, restores the Replace All focus, and has zero backend effect (A2)", async () => {
    const onReplaceMatches = vi.fn();
    await caseContext.openPreview(onReplaceMatches);

    fireEvent.keyDown(screen.getByTestId("code-workspace-replace-preview"), { key: "Escape" });
    expect(screen.queryByTestId("code-workspace-replace-preview")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId("code-workspace-find-replace-all"));
    expect(onReplaceMatches).not.toHaveBeenCalled();
  });

  // ED-AUDIT-003: a superseded search invalidates the frozen preview so a
  // stale plan can never commit after the result set moved underneath it.
  it("closes the frozen replace preview when a new search supersedes it (A2 stale)", async () => {
    const onReplaceMatches = vi.fn();
    await caseContext.openPreview(onReplaceMatches);
    expect(screen.getByTestId("code-workspace-replace-preview")).toBeInTheDocument();

    await runSearch("second");
    await waitFor(() =>
      expect(screen.queryByTestId("code-workspace-replace-preview")).not.toBeInTheDocument());
    expect(onReplaceMatches).not.toHaveBeenCalled();
  });

  // ED-AUDIT-003: an invalid regex surfaces as a search error before any
  // replace entry point can open; the Replace All gate stays disabled.
  it("shows an invalid regex error before preview and keeps Replace All disabled (A2)", async () => {
    render(
      <FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} onReplaceMatches={vi.fn()} />,
    );
    const unlisten = vi.fn();
    searchMocks.subscribeWorkspaceSearch.mockResolvedValue(unlisten);
    searchMocks.workspaceSearchStart.mockRejectedValue(
      new Error("Invalid search pattern: unclosed group"),
    );
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "foo(bar" } });
    // Enable the Regular expression toggle, then run the search.
    fireEvent.click(screen.getByRole("button", { name: "Regular expression" }));
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("code-workspace-find-error")).toBeInTheDocument());
    expect(screen.getByTestId("code-workspace-find-error")).toHaveTextContent("Invalid search pattern");
    expect(screen.getByRole("button", { name: "Preview replace all matches" })).toBeDisabled();
  });

  // ED-REPAIR-003: an illegal search-match coordinate (e.g. non-positive lineNumber)
  // surfaces as a replace error before preview open; zero commit.
  it("shows an illegal coordinate error when backend match has invalid line number (ED-REPAIR-003-A1)", async () => {
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
      searchMatch({ lineNumber: 0, lineText: "needle", matchStart: 0, matchEnd: 6, column: 1 }),
    ];
    act(() => {
      emit({ ...doneEvent(), kind: "batch", matches });
      emit(doneEvent({ totalMatches: matches.length }));
    });
    fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
    expect(await screen.findByTestId("code-workspace-replace-error"))
      .toHaveTextContent("invalid line number 0");
    expect(screen.queryByTestId("code-workspace-replace-preview")).not.toBeInTheDocument();
    expect(onReplaceMatches).not.toHaveBeenCalled();
  });

  // ED-REPAIR-006: case-distinct files on POSIX (e.g. A.java vs a.java) preserve
  // separate paths in preimages, snapshot, and committed WorkspaceEdit.
  it("preserves case distinction for A.java and a.java in preview and commit (ED-REPAIR-006-A1)", async () => {
    const posixRoots: CodeWorkspaceRootInfo[] = [
      { id: "root-1", name: "app", path: "/repo/app", kind: "git" },
    ];
    const onReplaceMatches = vi.fn(
      async (
        _matches: WorkspaceSearchMatch[],
        _replacement: string,
        _edit: LspWorkspaceEdit,
        _snapshot: unknown,
      ): Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; }> =>
        ({ ok: true as const, appliedCount: 2, fileCount: 2 }),
    );
    const onPrepareReplacePreimages = vi.fn(async (paths: readonly string[]) =>
      paths.map((path) => ({
        path,
        uri: `file://${path}`,
        textHash: `hash:${path}`,
        encoding: "UTF-8",
        bom: false,
        eol: "lf" as const,
        bufferRevision: 1,
        dirty: false,
        readOnly: false,
        workspaceInstanceId: "ws",
      })),
    );
    render(
      <FindInFilesPanel
        roots={posixRoots}
        onOpenMatch={vi.fn()}
        onReplaceMatches={onReplaceMatches}
        onPrepareReplacePreimages={onPrepareReplacePreimages}
      />,
    );
    const emit = await runSearch();
    const matches = [
      searchMatch({ rootPath: "/repo/app", path: "src/A.java", lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 }),
      searchMatch({ rootPath: "/repo/app", path: "src/a.java", lineNumber: 1, lineText: "needle two", matchStart: 0, matchEnd: 6, column: 1 }),
    ];
    act(() => {
      emit({ ...doneEvent(), kind: "batch", matches });
      emit(doneEvent({ totalMatches: matches.length }));
    });
    fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
    expect(await screen.findByTestId("code-workspace-replace-preview")).toBeInTheDocument();
    expect(onPrepareReplacePreimages).toHaveBeenCalledTimes(1);
    const preparedPaths = onPrepareReplacePreimages.mock.calls[0]![0];
    expect(preparedPaths).toHaveLength(2);
    expect(preparedPaths).toContain("/repo/app/src/A.java");
    expect(preparedPaths).toContain("/repo/app/src/a.java");

    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));
    await waitFor(() => expect(onReplaceMatches).toHaveBeenCalledTimes(1));
    const snapshot = onReplaceMatches.mock.calls[0]![3] as {
      preimages?: Array<{ path: string; textHash: string; }>;
    };
    expect(snapshot.preimages).toHaveLength(2);
    expect(snapshot.preimages?.map((p) => p.path)).toEqual(["/repo/app/src/A.java", "/repo/app/src/a.java"]);

    const passedEdit = onReplaceMatches.mock.calls[0]![2] as LspWorkspaceEdit;
    expect(passedEdit.documentEdits).toHaveLength(2);
    expect(passedEdit.documentEdits?.map((d) => d.path)).toEqual(["/repo/app/src/A.java", "/repo/app/src/a.java"]);
  });
}
