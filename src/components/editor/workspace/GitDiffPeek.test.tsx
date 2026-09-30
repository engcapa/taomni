import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GitDiffPeek } from "./GitDiffPeek";
import type { GitLineChange } from "./gitEditorChrome";

const change: GitLineChange = {
  kind: "modified",
  startLine: 2,
  endLine: 2,
  oldStartLine: 2,
  oldEndLine: 2,
  oldText: "old line",
  newText: "new line",
};

describe("ED-PARITY-022 GitDiffPeek", () => {
  afterEach(() => cleanup());

  it("offers previous/next, rollback, show diff and copy like IDEA's change popup", () => {
    const handlers = {
      onClose: vi.fn(),
      onRollback: vi.fn(),
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onShowDiff: vi.fn(),
      onCopy: vi.fn(),
    };
    render(<GitDiffPeek change={change} index={1} total={3} {...handlers} />);
    expect(screen.getByTestId("git-diff-peek-position").textContent).toBe("2 of 3");
    fireEvent.click(screen.getByTestId("git-diff-peek-next"));
    fireEvent.click(screen.getByTestId("git-diff-peek-previous"));
    fireEvent.click(screen.getByTestId("git-diff-peek-copy"));
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
    expect(handlers.onCopy).toHaveBeenCalledWith(change);
    fireEvent.click(screen.getByTestId("git-diff-peek-show-diff"));
    expect(handlers.onShowDiff).toHaveBeenCalledWith(change);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("git-diff-peek-old-line").map((line) => line.textContent)).toEqual(["−old line"]);
  });

  it("disables navigation for a single change and closes on Escape", () => {
    const onClose = vi.fn();
    render(<GitDiffPeek change={change} index={0} total={1} onClose={onClose} onPrevious={vi.fn()} onNext={vi.fn()} />);
    expect((screen.getByTestId("git-diff-peek-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId("code-workspace-git-diff-peek"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
