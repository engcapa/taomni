import { findEditorByTitle } from "../../editorReadiness";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { installSaveRaceProbe, uninstallSaveRaceProbe } from "../../../saveRaceProbe";
import { hasBlockingDiskEffectResolution, listDiskEffectLedgerEntries, resolveDiskEffectLedgerEntry } from "../../../workspaceRecovery";
import { type registerSaveCasesFixture } from "../../save.cases";

export interface registeratomicSaveHistory2CasesContext {
  workspaceTestHarness: registerSaveCasesFixture;
}

export function registeratomicSaveHistory2Cases(caseContext: registeratomicSaveHistory2CasesContext) {

  it("QA gate W1: keeps edits typed after the real writer was invoked and before its ack is delivered", async () => {
    installSaveRaceProbe();
    try {
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        writtenPath: string,
        text: string,
      ) => caseContext.workspaceTestHarness.writeAck(
        caseContext.workspaceTestHarness.file(writtenPath, text, { hash: `hash-saved-${writtenPath}` }),
        { oldHash: `hash-${writtenPath}` },
      ));
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-gate-w1",
        workspaceInstanceId: "instance-save-gate-w1",
        name: "Save Gate W1",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "gate_text\n"));

      const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await findEditorByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();

      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-gate-w1",
      ).openFiles["root:app:src/main.ts"]?.text).toBe("gate_text\ngate_text\n"));

      const control = caseContext.workspaceTestHarness.saveRaceGate();
      expect(control.arm({
        stage: "ack",
        filePath: "/repo/app/src/main.ts",
        timeoutMs: 15_000,
      })).toMatchObject({ ok: true });
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(control.status().held?.stage).toBe("ack"));
      // W1: the real writer was invoked; only its ack delivery is held.
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);

      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: "X" },
          selection: { anchor: view!.state.doc.length + 1 },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-gate-w1",
      ).openFiles["root:app:src/main.ts"]?.text).toBe("gate_text\ngate_text\nX"));

      control.release();
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-gate-w1",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.savedText).toBe("gate_text\ngate_text\n");
        expect(fileState?.text).toBe("gate_text\ngate_text\nX");
        expect(fileState?.dirty).toBe(true);
        expect(fileState?.saving).toBe(false);
      });
      expect(screen.getByTestId("code-workspace-save-observation"))
        .toHaveAttribute("data-result-kind", "saved-stale-snapshot");
      expect(control.trace().map((entryTrace) => entryTrace.event))
        .toEqual(["arm", "writer-invoked", "enter", "release", "ack-delivered", "watcher-invoked", "commit-settled"]);
    } finally {
      uninstallSaveRaceProbe();
    }
  });

  it("QA gate W2: keeps edits typed after the ack and before the watcher completion", async () => {
    installSaveRaceProbe();
    try {
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        writtenPath: string,
        text: string,
      ) => caseContext.workspaceTestHarness.writeAck(
        caseContext.workspaceTestHarness.file(writtenPath, text, { hash: `hash-saved-${writtenPath}` }),
        { oldHash: `hash-${writtenPath}` },
      ));
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-gate-w2",
        workspaceInstanceId: "instance-save-gate-w2",
        name: "Save Gate W2",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "gate_text\n"));

      const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await findEditorByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();

      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-gate-w2",
      ).openFiles["root:app:src/main.ts"]?.text).toBe("gate_text\ngate_text\n"));

      const control = caseContext.workspaceTestHarness.saveRaceGate();
      expect(control.arm({
        stage: "watcher",
        filePath: "/repo/app/src/main.ts",
        timeoutMs: 15_000,
      })).toMatchObject({ ok: true });
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(control.status().held?.stage).toBe("watcher"));
      // W2: the real writer acked and the real watcher notify was invoked.
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
      expect(caseContext.workspaceTestHarness.lspMocks.lspWorkspaceDidChangeWatchedFiles).toHaveBeenCalledTimes(1);
      expect(control.trace().map((entryTrace) => entryTrace.event))
        .toEqual(["arm", "writer-invoked", "ack-delivered", "watcher-invoked", "enter"]);

      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: "X" },
          selection: { anchor: view!.state.doc.length + 1 },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-gate-w2",
      ).openFiles["root:app:src/main.ts"]?.text).toBe("gate_text\ngate_text\nX"));

      control.release();
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-gate-w2",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.savedText).toBe("gate_text\ngate_text\n");
        expect(fileState?.text).toBe("gate_text\ngate_text\nX");
        expect(fileState?.dirty).toBe(true);
        expect(fileState?.saving).toBe(false);
      });
      expect(control.trace().map((entryTrace) => entryTrace.event))
        .toEqual(["arm", "writer-invoked", "ack-delivered", "watcher-invoked", "enter", "release", "commit-settled"]);
      expect(screen.getByTestId("code-workspace-save-observation"))
        .toHaveAttribute("data-result-kind", "saved-stale-snapshot");
    } finally {
      uninstallSaveRaceProbe();
    }
  });

  it("discards writeback and never recreates a closed buffer when writer resolves after close", async () => {
    let resolveWrite: (res: any) => void = () => { };
    const writeDeferred = new Promise<any>((r) => {
      resolveWrite = r;
    });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockReturnValue(writeDeferred);

    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-save-race-close",
      workspaceInstanceId: "instance-save-race-close",
      name: "Save Race Close",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "close_race\n"));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    // Dirty the buffer, then start a save whose writer stays in flight.
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-close",
      ).openFiles["root:app:src/main.ts"];
      expect(fileState?.dirty).toBe(true);
    });
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => {
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalled();
    });

    // Close the tab while the writer is pending (dialog mock confirms).
    const closeButton = rendered.container.querySelector<HTMLElement>(
      '[data-editor-tab-key="root:app:src/main.ts"] button[title="Close"]',
    );
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton!);
    await waitFor(() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-save-race-close");
      expect(ui.openFiles["root:app:src/main.ts"]).toBeUndefined();
    });

    // Writer finishes with the stale snapshot: writeback must be discarded.
    await act(async () => {
      resolveWrite(caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file("src/main.ts", "close_race\nclose_race\n", { hash: "hash-closed-snapshot" })));
    });

    const uiAfter = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-save-race-close");
    expect(uiAfter.openFiles["root:app:src/main.ts"]).toBeUndefined();
    expect(caseContext.workspaceTestHarness.lspMocks.lspSaveDocument).not.toHaveBeenCalled();

    // §8.19.1: a discarded writeback must leave a committed ledger row so
    // the recovery center can surface "saved to disk, buffer discarded".
    const ledgerRows = listDiskEffectLedgerEntries("instance-save-race-close")
      .filter((row) => row.path === "/repo/app/src/main.ts");
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      resolution: "confirmed-committed",
      intendedNewHash: "hash-closed-snapshot",
      observedHash: "hash-closed-snapshot",
    });
    expect(hasBlockingDiskEffectResolution("instance-save-race-close", "/repo/app/src/main.ts")).toBe(false);
    resolveDiskEffectLedgerEntry("instance-save-race-close", ledgerRows[0].transactionId, "/repo/app/src/main.ts");
  });

  it("records unknown disk effects for recovery and blocks an automatic retry", async () => {
    const path = "src/main.ts";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-save-unknown-effect",
      workspaceInstanceId: "instance-save-unknown-effect",
      name: "Save Unknown Effect",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(path, "initial\n"));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(caseContext.workspaceTestHarness.file(path, "foreign\n", {
      hash: "foreign-disk-hash",
    }));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
      new Error("atomic replace acknowledgement was lost"),
      {
        kind: "io",
        effect: "unknown",
        intentHash: "intended-new-hash",
        intentByteLength: 16,
        oldHash: `hash-${path}`,
      },
    ));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle(`app / ${path}`);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-save-unknown-effect",
    ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save result unknown"));
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
      "/repo/app",
      path,
      "UTF-8",
    );
    const recoveryObservation = screen.getByTestId("code-workspace-save-observation");
    expect(recoveryObservation).toHaveAttribute("data-state", "recovery");
    expect(recoveryObservation).toHaveAttribute("data-result-kind", "failed");
    expect(recoveryObservation).toHaveAttribute("data-disk-effect", "unknown");
    expect(recoveryObservation).toHaveAttribute("data-recovery-id", expect.stringMatching(/^tx-save-/));
    expect(recoveryObservation).not.toHaveAttribute("data-receipt-id");
    expect(recoveryObservation).toHaveTextContent("Save recovery required for main.ts");

    const ledgerRows = listDiskEffectLedgerEntries("instance-save-unknown-effect")
      .filter((row) => row.path === `/repo/app/${path}`);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      transactionId: expect.stringMatching(/^tx-save-/),
      expectedOldHash: `hash-${path}`,
      intendedNewHash: "intended-new-hash",
      observedHash: "foreign-disk-hash",
      diskEffect: "unknown",
      memoryEffect: "unchanged",
      providerEffect: "unknown",
      resolution: "foreign-blocked",
    });
    expect(hasBlockingDiskEffectResolution(
      "instance-save-unknown-effect",
      `/repo/app/${path}`,
    )).toBe(true);

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save blocked"));
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);

    resolveDiskEffectLedgerEntry(
      "instance-save-unknown-effect",
      ledgerRows[0].transactionId,
      `/repo/app/${path}`,
    );
  });

  it("surfaces a real hash-mismatch save as conflict with zero disk effect and no blocking row", async () => {
    const path = "src/main.ts";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-save-external-conflict",
      workspaceInstanceId: "instance-save-external-conflict",
      name: "Save External Conflict",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(path, "disk_v1\n"));
    // Native precondition failure (§ED-AUDIT-004 A3): the disk changed under
    // the dirty buffer (external rewrite between load and save). The native
    // writer proves zero bytes landed via effect=none and never fabricates a
    // success receipt.
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
      new Error("disk hash changed since load"),
      {
        kind: "hash-mismatch",
        expectedHash: `hash-${path}`,
        actualHash: "hash-external-rewrite",
        effect: "none",
      },
    ));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle(`app / ${path}`);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-save-external-conflict",
    ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save conflict"));
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);

    const conflictObservation = screen.getByTestId("code-workspace-save-observation");
    expect(conflictObservation).toHaveAttribute("data-state", "conflict");
    expect(conflictObservation).toHaveAttribute("data-result-kind", "conflict");
    expect(conflictObservation).toHaveAttribute("data-disk-effect", "none");
    expect(conflictObservation).toHaveAttribute("data-dirty", "true");
    expect(conflictObservation).not.toHaveAttribute("data-receipt-id");
    expect(conflictObservation).not.toHaveAttribute("data-recovery-id");

    // The buffer keeps the user's edits dirty; no ledger row blocks a later
    // save because a conflict provably wrote nothing.
    const fileState = selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-save-external-conflict",
    ).openFiles[`root:app:${path}`];
    expect(fileState?.dirty).toBe(true);
    expect(fileState?.text).toBe("disk_v1\ndisk_v1\n");
    expect(hasBlockingDiskEffectResolution(
      "instance-save-external-conflict",
      `/repo/app/${path}`,
    )).toBe(false);

    // A conflict never blocks the retry: the next Ctrl+S invokes the
    // writer again against the refreshed expectation.
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2));
  });

  it("continues a lost-acknowledge save as committed when the read-back proves the intended bytes landed", async () => {
    const path = "src/main.ts";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-save-unknown-committed",
      workspaceInstanceId: "instance-save-unknown-committed",
      name: "Save Unknown Committed",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(path, "initial\n"));
    // Native unknown-effect contract: the atomic replace acknowledgement was
    // lost, so the error carries the intent hash and old hash but no proof.
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
      new Error("atomic replace acknowledgement was lost"),
      {
        kind: "io",
        effect: "unknown",
        intentHash: "intended-new-hash",
        intentByteLength: 16,
        oldHash: `hash-${path}`,
      },
    ));
    // The frontend read-back proves the intended bytes are on disk.
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(caseContext.workspaceTestHarness.file(path, "initial\ninitial\n", {
      hash: "intended-new-hash",
    }));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle(`app / ${path}`);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-save-unknown-committed",
    ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Saved"));
    // Exactly one write attempt and one real read-back verification.
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
      "/repo/app",
      path,
      "UTF-8",
    );

    const savedObservation = screen.getByTestId("code-workspace-save-observation");
    expect(savedObservation).toHaveAttribute("data-state", "saved");
    expect(savedObservation).toHaveAttribute("data-result-kind", "saved-current");
    expect(savedObservation).toHaveAttribute("data-disk-effect", "committed");
    expect(savedObservation).toHaveAttribute("data-dirty", "false");
    expect(savedObservation).toHaveAttribute("data-receipt-id", expect.stringMatching(/^receipt-tx-save-/));
    expect(savedObservation).toHaveAttribute("data-encoded-bytes-sha256", "intended-new-hash");
    expect(savedObservation).toHaveAttribute("data-disk-pre-sha256", `hash-${path}`);
    expect(savedObservation).toHaveAttribute("data-disk-post-sha256", "intended-new-hash");
    expect(savedObservation).toHaveAttribute("data-write-count", "1");
    expect(savedObservation).not.toHaveAttribute("data-recovery-id");

    // The verified-committed path never leaves a blocking ledger row.
    expect(hasBlockingDiskEffectResolution(
      "instance-save-unknown-committed",
      `/repo/app/${path}`,
    )).toBe(false);

    // The provider is synced with the proven on-disk text.
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspSaveDocument).toHaveBeenCalledWith(
      expect.anything(),
      "initial\ninitial\n",
      expect.anything(),
    ));
  });
}
