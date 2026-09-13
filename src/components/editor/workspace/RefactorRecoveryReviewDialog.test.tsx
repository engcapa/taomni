import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { RefactorRecoveryReviewDialog } from "./RefactorRecoveryReviewDialog";
import { sha256Hex } from "./projectAnalysisModel";
import type { RefactorRecoveryJournalEntryV2 } from "./refactorPlan";
import type { RefactorRecoveryPreconditionSummary } from "./refactorRecoveryController";

afterEach(cleanup);

const preText = "public class MyTest {}";
const postText = "public class MyTesting {}";

const entry: RefactorRecoveryJournalEntryV2 = {
  schemaVersion: 2,
  recoveryId: "rec-dialog-1",
  transactionId: "tx-dialog-1",
  actionId: "rename:test",
  kind: "rename",
  workspaceRoot: "/repo/app",
  createdAt: 100,
  updatedAt: 200,
  status: "recovery-required",
  appliedOperationIndex: null,
  documents: [{
    uri: "file:///repo/app/src/MyTest.java",
    canonicalPath: "/repo/app/src/MyTest.java",
    preText,
    preHash: sha256Hex(preText),
    postText,
    postHash: sha256Hex(postText),
    encoding: "UTF-8",
    bom: false,
    eol: "lf",
  }],
  resourceMoves: [{
    oldUri: "file:///repo/app/src/MyTest.java",
    newUri: "file:///repo/app/src/MyTesting.java",
    oldPath: "/repo/app/src/MyTest.java",
    newPath: "/repo/app/src/MyTesting.java",
    contentHash: sha256Hex(preText),
  }],
  verification: { mismatchedUris: [], checkedAt: null },
};

const restorable: RefactorRecoveryPreconditionSummary = {
  documents: [{ uri: entry.documents[0]!.uri, canonicalPath: entry.documents[0]!.canonicalPath, state: "restorable", currentHash: "x" }],
  moves: [{
    oldUri: entry.resourceMoves[0]!.oldUri,
    newUri: entry.resourceMoves[0]!.newUri,
    oldPath: entry.resourceMoves[0]!.oldPath,
    newPath: entry.resourceMoves[0]!.newPath,
    state: "restorable",
    currentHash: "x",
    contentVerified: true,
    detail: "restorable",
  }],
  overall: "restorable",
};

const conflict: RefactorRecoveryPreconditionSummary = {
  documents: [{ uri: entry.documents[0]!.uri, canonicalPath: entry.documents[0]!.canonicalPath, state: "unreadable", currentHash: null }],
  moves: [{
    oldUri: entry.resourceMoves[0]!.oldUri,
    newUri: entry.resourceMoves[0]!.newUri,
    oldPath: entry.resourceMoves[0]!.oldPath,
    newPath: entry.resourceMoves[0]!.newPath,
    state: "conflict",
    currentHash: null,
    contentVerified: true,
    detail: "both-missing",
  }],
  overall: "conflict",
};

function renderDialog(summary: RefactorRecoveryPreconditionSummary | null, overrides = {}) {
  const handlers = {
    onKeep: vi.fn(),
    onRestore: vi.fn(),
    onDismiss: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <RefactorRecoveryReviewDialog
      entry={entry}
      workspaceRoot="/repo/app"
      preconditions={summary}
      loading={summary === null}
      error={null}
      busy={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("RefactorRecoveryReviewDialog (RC-02/AC-02/07)", () => {
  it("lists every affected resource with full paths and keeps restore available when restorable", () => {
    renderDialog(restorable);
    expect(screen.getByTestId("refactor-recovery-review")).toBeInTheDocument();
    expect(screen.getAllByTestId("refactor-recovery-resource")).toHaveLength(2);
    expect(screen.getByTestId("refactor-recovery-restore")).toBeEnabled();
    expect(screen.getByTestId("refactor-recovery-dismiss")).toBeEnabled();
    expect(screen.getByTestId("refactor-recovery-keep")).toBeEnabled();
  });

  it("disables restore on conflict, never claims the user deleted files", () => {
    renderDialog(conflict);
    expect(screen.getByTestId("refactor-recovery-restore")).toBeDisabled();
    // Both ends missing is stated as non-existence, never attributed to the user.
    const text = screen.getByTestId("refactor-recovery-review").textContent ?? "";
    expect(text).toContain("does not exist");
    expect(text).not.toContain("you deleted");
    expect(text).not.toContain("user deleted");
  });

  it("requires a second cancel-focused confirm before abandoning (DEC-01)", async () => {
    const handlers = renderDialog(restorable);
    fireEvent.click(screen.getByTestId("refactor-recovery-dismiss"));
    // First click only opens the inline confirm; nothing persisted yet.
    expect(handlers.onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("refactor-recovery-dismiss-confirm")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("refactor-recovery-dismiss-cancel")).toHaveFocus());
    fireEvent.click(screen.getByTestId("refactor-recovery-dismiss-confirm-button"));
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("cancelling the second confirm keeps the review open with zero effects", () => {
    const handlers = renderDialog(restorable);
    fireEvent.click(screen.getByTestId("refactor-recovery-dismiss"));
    fireEvent.click(screen.getByTestId("refactor-recovery-dismiss-cancel"));
    expect(handlers.onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByTestId("refactor-recovery-dismiss-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("refactor-recovery-review")).toBeInTheDocument();
  });

  it("breaks long paths instead of overflowing (AC-07)", () => {
    renderDialog(restorable);
    const resources = screen.getAllByTestId("refactor-recovery-resource");
    for (const row of resources) {
      expect(row.className).toContain("rounded");
      const label = row.querySelector("div");
      expect(label?.className).toContain("break-all");
    }
    const dialog = screen.getByTestId("refactor-recovery-review");
    expect(dialog.className).toContain("w-[min(640px,92vw)]");
    expect(dialog.className).toContain("max-h-[90vh]");
  });
});
