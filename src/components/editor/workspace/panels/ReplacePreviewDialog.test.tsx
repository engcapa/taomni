import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplacePreviewDialog, stableUsageKey } from "./ReplacePreviewDialog";
import {
  buildReplaceInFilesWorkspaceEdit,
  type ReplaceInFilesMatch,
} from "../replaceInFilesModel";

type CommitHandler = (excludedKeys: ReadonlySet<string>) => void;
type CancelHandler = () => void;
type CommitMock = ReturnType<typeof vi.fn<CommitHandler>>;
type CancelMock = ReturnType<typeof vi.fn<CancelHandler>>;

function sampleMatches(): ReplaceInFilesMatch[] {
  return [
    { filePath: "/ws/a.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, matchedText: "needle" },
    { filePath: "/ws/a.ts", startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 6, matchedText: "needle" },
    { filePath: "/ws/b.ts", startLine: 2, startCharacter: 4, endLine: 2, endCharacter: 10, matchedText: "needle" },
  ];
}

function renderDialog(onCommit: CommitMock = vi.fn<CommitHandler>(), onCancel: CancelMock = vi.fn<CancelHandler>()) {
  const edit = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches(), replacementText: "thread" });
  render(
    <ReplacePreviewDialog
      edit={edit}
      replacement="thread"
      committing={false}
      commitError={null}
      onCommit={onCommit}
      onCancel={onCancel}
    />,
  );
  return { onCommit, onCancel };
}

describe("ED-FIND-004: ReplacePreviewDialog", () => {
  afterEach(() => {
    cleanup();
  });
  it("groups usages by file with live counts (A1)", () => {
    renderDialog();
    expect(screen.getByTestId("code-workspace-replace-preview")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("3 of 3");
    expect(screen.getAllByTestId("code-workspace-replace-usage")).toHaveLength(3);
    expect(screen.getByTestId("code-workspace-replace-commit")).toHaveTextContent("Replace 3");
  });

  it("rebuilds the plan on exclusion and commits the remainder (A1)", () => {
    const { onCommit } = renderDialog();
    const usages = screen.getAllByTestId("code-workspace-replace-usage");
    fireEvent.click(usages[0]);
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("2 of 3");
    expect(screen.getByTestId("code-workspace-replace-commit")).toHaveTextContent("Replace 2");

    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    const excluded = onCommit.mock.calls[0][0] as ReadonlySet<string>;
    expect(excluded.size).toBe(1);
  });

  it("toggles whole files and surfaces commit errors without closing (A1/A2)", () => {
    const { onCommit } = renderDialog();
    const fileToggle = screen.getByLabelText("Include all matches in /ws/a.ts");
    fireEvent.click(fileToggle);
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("1 of 3");

    fireEvent.click(screen.getByTestId("code-workspace-replace-cancel"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("disables commit when everything is excluded (A2 zero commit)", () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText("Include all matches in /ws/a.ts"));
    fireEvent.click(screen.getByLabelText("Include all matches in /ws/b.ts"));
    expect(screen.getByTestId("code-workspace-replace-commit")).toBeDisabled();
  });
});

describe("ED-PARITY-006: seeded exclusion, summary and keyboard", () => {
  afterEach(() => {
    cleanup();
  });

  function renderParityDialog(options: {
    committing?: boolean;
    onCommit?: CommitMock;
    onCancel?: CancelMock;
    initialExcludedKeys?: ReadonlySet<string>;
  } = {}) {
    const onCommit = options.onCommit ?? vi.fn<CommitHandler>();
    const onCancel = options.onCancel ?? vi.fn<CancelHandler>();
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches(), replacementText: "coin" });
    render(
      <ReplacePreviewDialog
        edit={edit}
        replacement="coin"
        query="token"
        initialExcludedKeys={options.initialExcludedKeys}
        committing={options.committing ?? false}
        commitError={null}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    return { onCommit, onCancel };
  }

  it("keeps a seeded exclusion visible and reports the exact summary", () => {
    const excludedKey = stableUsageKey("/ws/a.ts", 1, 0, 1, 6);
    renderParityDialog({ initialExcludedKeys: new Set([excludedKey]) });

    expect(screen.getByTestId("code-workspace-replace-summary")).toHaveTextContent(
      "Replace 2 occurrences of 'token' across 2 files with 'coin'?",
    );
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("2 of 3");
    const usages = screen.getAllByTestId("code-workspace-replace-usage");
    expect(usages).toHaveLength(3);
    expect((usages[1] as HTMLInputElement).checked).toBe(false);
  });

  it("cancels from Escape without committing", () => {
    const { onCommit, onCancel } = renderParityDialog();
    fireEvent.keyDown(screen.getByTestId("code-workspace-replace-preview"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits from Enter on the dialog but not from a checkbox", () => {
    const { onCommit } = renderParityDialog();
    const dialog = screen.getByTestId("code-workspace-replace-preview");
    const checkbox = screen.getAllByTestId("code-workspace-replace-usage")[0]!;
    fireEvent.keyDown(checkbox, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("focuses the primary action and loops Tab within all dialog controls", async () => {
    renderParityDialog();
    const commit = screen.getByTestId("code-workspace-replace-commit");
    const first = screen.getAllByTestId("code-workspace-replace-file-toggle")[0]!;
    await waitFor(() => expect(document.activeElement).toBe(commit));
    fireEvent.keyDown(screen.getByTestId("code-workspace-replace-preview"), { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(screen.getByTestId("code-workspace-replace-preview"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(commit);
  });

  it("focuses the primary before another animation frame can route Enter to the editor", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    try {
      renderParityDialog();
      expect(document.activeElement).toBe(screen.getByTestId("code-workspace-replace-commit"));
    } finally {
      frame.mockRestore();
    }
  });

  it("keeps focus inside while committing and restores the primary after a blocked commit", () => {
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches(), replacementText: "coin" });
    const props = { edit, replacement: "coin", commitError: null, onCommit: vi.fn(), onCancel: vi.fn() };
    const rendered = render(<ReplacePreviewDialog {...props} committing={false} />);
    rendered.rerender(<ReplacePreviewDialog {...props} committing />);
    expect(document.activeElement).toBe(screen.getByTestId("code-workspace-replace-preview"));
    rendered.rerender(<ReplacePreviewDialog {...props} committing={false} commitError="Replace blocked" />);
    expect(document.activeElement).toBe(screen.getByTestId("code-workspace-replace-commit"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("Enter on Cancel cancels without committing", () => {
    const { onCommit, onCancel } = renderParityDialog();
    fireEvent.keyDown(screen.getByTestId("code-workspace-replace-cancel"), { key: "Enter" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not commit or cancel while committing", () => {
    const { onCommit, onCancel } = renderParityDialog({ committing: true });
    const dialog = screen.getByTestId("code-workspace-replace-preview");
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
