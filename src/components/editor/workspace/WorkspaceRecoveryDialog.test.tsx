import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRecoveryDialog } from "./WorkspaceRecoveryDialog";
import type { WorkspaceRecoveryEntry } from "./workspaceRecovery";
import type { RefactorRecoveryJournalEntry } from "./refactorPlan";

afterEach(() => cleanup());

const recovery: WorkspaceRecoveryEntry = {
  workspaceId: "ws",
  key: "root:root:src/Main.ts",
  ref: { kind: "root", rootId: "root", path: "src/Main.ts" },
  path: "/repo/src/Main.ts",
  text: "const value = 2;",
  savedText: "const value = 1;",
  eol: "LF",
  hash: "hash",
  mtime: 1,
  size: 16,
  capturedAt: Date.now(),
};

const refactorRecovery: RefactorRecoveryJournalEntry = {
  schemaVersion: 2,
  workspaceId: "ws",
  recoveryId: "refactor-recovery-1",
  transactionId: "tx-1",
  actionId: "rename:Main",
  kind: "rename",
  workspaceRoot: "/repo",
  createdAt: 1,
  updatedAt: 1,
  status: "recovery-required",
  appliedOperationIndex: 0,
  operationCount: 1,
  documents: [{
    uri: "file:///repo/src/Main.ts",
    canonicalPath: "/repo/src/Main.ts",
    preText: "const value = 1;",
    preHash: "pre",
    postText: "const value = 2;",
    postHash: "post",
    encoding: "UTF-8",
    bom: false,
    eol: "lf",
    preDocumentRevision: 1,
  }],
};

describe("WorkspaceRecoveryDialog", () => {
  it("recovers or discards the selected buffer", () => {
    const onRecover = vi.fn();
    const onDiscard = vi.fn();
    render(
      <WorkspaceRecoveryDialog
        entries={[recovery]}
        onRecover={onRecover}
        onDiscard={onDiscard}
        onRecoverAll={() => undefined}
        onDiscardAll={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("const value = 2;")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recover selected" }));
    expect(onRecover).toHaveBeenCalledWith(recovery);
    fireEvent.click(screen.getByRole("button", { name: "Discard selected" }));
    expect(onDiscard).toHaveBeenCalledWith(recovery);
  });

  it("offers bulk actions and decide-later close", () => {
    const onRecoverAll = vi.fn();
    const onDiscardAll = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceRecoveryDialog
        entries={[recovery]}
        onRecover={() => undefined}
        onDiscard={() => undefined}
        onRecoverAll={onRecoverAll}
        onDiscardAll={onDiscardAll}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    fireEvent.click(screen.getByRole("button", { name: "Recover all" }));
    fireEvent.click(screen.getByRole("button", { name: "Decide later" }));
    expect(onRecoverAll).toHaveBeenCalledTimes(1);
    expect(onDiscardAll).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces refactor recovery and only enables recovery for v2", async () => {
    const onRecoverRefactor = vi.fn();
    const onDiscardRefactor = vi.fn();
    render(
      <WorkspaceRecoveryDialog
        entries={[]}
        onRecover={() => undefined}
        onDiscard={() => undefined}
        onRecoverAll={() => undefined}
        onDiscardAll={() => undefined}
        onClose={() => undefined}
        refactorEntries={[refactorRecovery]}
        onRecoverRefactor={onRecoverRefactor}
        onDiscardRefactor={onDiscardRefactor}
      />,
    );

    expect(screen.getByTestId("workspace-recovery-refactors")).toBeInTheDocument();
    expect(screen.getAllByText("rename:Main")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Recover refactor" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard refactor recovery for rename:Main" }));
    expect(onRecoverRefactor).toHaveBeenCalledWith(refactorRecovery);
    expect(onDiscardRefactor).toHaveBeenCalledWith(refactorRecovery);
  });

  it("selects the refactor tab when pending entries arrive after mount", async () => {
    const props = {
      entries: [],
      onRecover: () => undefined,
      onDiscard: () => undefined,
      onRecoverAll: () => undefined,
      onDiscardAll: () => undefined,
      onClose: () => undefined,
    };
    const rendered = render(<WorkspaceRecoveryDialog {...props} refactorEntries={[]} />);
    rendered.rerender(<WorkspaceRecoveryDialog {...props} refactorEntries={[refactorRecovery]} />);

    await waitFor(() => expect(screen.getByTestId("workspace-recovery-refactors")).toBeInTheDocument());
  });
});
