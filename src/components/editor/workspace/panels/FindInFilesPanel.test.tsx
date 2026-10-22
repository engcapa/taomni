import "./tests/findInFilesPanel/harness";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, vi } from "vitest";
import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import type { WorkspaceSearchMatch } from "../../../../lib/editor/workspaceSearch";
import { FindInFilesPanel } from "./FindInFilesPanel";
import { doneEvent, roots, runSearch, searchMatch } from "./tests/findInFilesPanel/harness";
import { registerFindInFilesPanelLayout1Cases } from "./tests/findInFilesPanel/layout1.cases";
import { registerFindInFilesPanelLayout2Cases } from "./tests/findInFilesPanel/layout2.cases";
import { registerFindInFilesPanelLifecycle3Cases } from "./tests/findInFilesPanel/lifecycle3.cases";
import { registerFindInFilesPanelLifecycle4Cases } from "./tests/findInFilesPanel/lifecycle4.cases";

registerFindInFilesPanelLayout1Cases();

registerFindInFilesPanelLayout2Cases();

describe("ED-FIND-004: replace preview commit flow in FindInFilesPanel", () => {
  afterEach(() => {
    cleanup();
  });

  async function openPreview(
    onReplaceMatches: (
      matches: WorkspaceSearchMatch[],
      replacement: string,
      edit: LspWorkspaceEdit,
    ) => Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string; }>,
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
    return matches;
  }
  registerFindInFilesPanelLifecycle3Cases({
    get openPreview() { return openPreview; },
  });
  registerFindInFilesPanelLifecycle4Cases();
});
