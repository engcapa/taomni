import { findEditorByTitle } from "../../editorReadiness";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { installSaveRaceProbe, uninstallSaveRaceProbe } from "../../../saveRaceProbe";
import { type registerSaveCasesFixture } from "../../save.cases";

export interface registeratomicSaveHistory1CasesContext {
  workspaceTestHarness: registerSaveCasesFixture;
}

export function registeratomicSaveHistory1Cases(caseContext: registeratomicSaveHistory1CasesContext) {
  it("deletes a Java line with Ctrl+Y and saves from the editor surface", async () => {
    const path = "src/main/java/com/example/App.java";
    const initialText = "class App {\n  int value = 1;\n}\n";
    const savedText = "  int value = 1;\n}\n";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-editor-delete-save",
      workspaceInstanceId: "instance-editor-delete-save",
      name: "Editor Delete Save",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(path, initialText));
    caseContext.workspaceTestHarness.localHistoryMocks.historySnapshot.mockResolvedValue({
      id: 41,
      path: `/repo/app/${path}`,
      contentHash: "history-preimage-hash",
      createdAt: 1_788_888_888,
      reason: "save",
      byteLen: initialText.length,
    });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _root: string,
      writtenPath: string,
      text: string,
    ) => caseContext.workspaceTestHarness.writeAck(
      caseContext.workspaceTestHarness.file(writtenPath, text, { hash: `hash-saved-${writtenPath}` }),
      {
        intentHash: `hash-saved-${writtenPath}`,
        oldHash: `hash-${writtenPath}`,
      },
    ));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle(`app / ${path}`);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    fireEvent.keyDown(content!, { key: "y", code: "KeyY", ctrlKey: true });
    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-editor-delete-save",
      ).openFiles[`root:app:${path}`];
      expect(fileState?.text).toBe(savedText);
      expect(fileState?.dirty).toBe(true);
    });
    expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-state", "dirty");
    expect(screen.getByTestId("code-workspace-save-observation")).toHaveTextContent("Unsaved changes in App.java");

    fireEvent.keyDown(content!, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      path,
      savedText,
      `hash-${path}`,
      "UTF-8",
      false,
    ));
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(caseContext.workspaceTestHarness.saveCommitObservations.results).toHaveLength(1));
    const result = caseContext.workspaceTestHarness.saveCommitObservations.results[0];
    expect(result).toMatchObject({
      kind: "saved-current",
      diskEffect: "committed",
      historyId: "local-history-41",
      receipt: {
        workspaceId: "instance-editor-delete-save",
        filePath: `/repo/app/${path}`,
        writeCount: 1,
        encodedBytesSha256: `hash-saved-${path}`,
        encodedByteLength: savedText.length,
        diskPreSha256: `hash-${path}`,
        diskPostSha256: `hash-saved-${path}`,
        historyId: "local-history-41",
      },
    });
    expect((result as { receipt: { receiptId: string; transactionId: string; finalTextSha256: string; }; }).receipt)
      .toMatchObject({
        receiptId: expect.stringMatching(/^receipt-tx-save-/),
        transactionId: expect.stringMatching(/^tx-save-/),
        finalTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    const saveObservation = screen.getByTestId("code-workspace-save-observation");
    expect(saveObservation).toHaveAttribute("data-state", "saved");
    expect(saveObservation).toHaveAttribute("data-result-kind", "saved-current");
    expect(saveObservation).toHaveAttribute("data-receipt-id", expect.stringMatching(/^receipt-tx-save-/));
    expect(saveObservation).toHaveAttribute("data-encoded-bytes-sha256", `hash-saved-${path}`);
    expect(saveObservation).toHaveAttribute("data-write-count", "1");
    expect(saveObservation).toHaveAttribute("data-dirty", "false");
    expect(saveObservation).toHaveAccessibleName("Save status");
    expect(saveObservation).toHaveAttribute("aria-live", "polite");
    expect(saveObservation).toHaveTextContent("Saved App.java");
  });

  it("cancels save with 0 disk writes when user edits buffer during historySnapshot await", async () => {
    let resolveHistory: () => void = () => { };
    const historyDeferred = new Promise<null>((r) => {
      resolveHistory = () => r(null);
    });
    caseContext.workspaceTestHarness.localHistoryMocks.historySnapshot.mockReturnValue(historyDeferred);

    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-save-race-history",
      workspaceInstanceId: "instance-save-race-history",
      name: "Save Race History",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "original_v1\n"));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    // Make buffer dirty first by typing Ctrl+D (duplicate line)
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-history",
      ).openFiles["root:app:src/main.ts"];
      expect(fileState?.dirty).toBe(true);
      expect(fileState?.text).toBe("original_v1\noriginal_v1\n");
    });

    // Trigger Save (Ctrl+S) -> enters prepare phase and awaits historySnapshot
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

    await waitFor(() => {
      expect(caseContext.workspaceTestHarness.localHistoryMocks.historySnapshot).toHaveBeenCalled();
    });

    // While historySnapshot is awaiting, user edits buffer again (Ctrl+D)
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-history",
      ).openFiles["root:app:src/main.ts"];
      expect(fileState?.text).toBe("original_v1\noriginal_v1\noriginal_v1\n");
    });

    // Now resolve historySnapshot
    await act(async () => {
      resolveHistory();
    });

    // Assert pre-write commit boundary cancelled save: zero disk writes
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteLooseFileEncoded).not.toHaveBeenCalled();
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

    // Editor and store retain latest user edits, dirty remains true
    const finalFileState = selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-save-race-history",
    ).openFiles["root:app:src/main.ts"];
    expect(finalFileState?.text).toBe("original_v1\noriginal_v1\noriginal_v1\n");
    expect(finalFileState?.dirty).toBe(true);
    expect(finalFileState?.saving).toBe(false);
  });

  it("preserves concurrent edits and marks dirty when disk write was in-flight", async () => {
    let resolveWrite: (res: any) => void = () => { };
    const writeDeferred = new Promise<any>((r) => {
      resolveWrite = r;
    });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockReturnValue(writeDeferred);

    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-save-race-inflight",
      workspaceInstanceId: "instance-save-race-inflight",
      name: "Save Race InFlight",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "initial_text\n"));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    // Make buffer dirty (Ctrl+D)
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-inflight",
      ).openFiles["root:app:src/main.ts"];
      expect(fileState?.dirty).toBe(true);
      expect(fileState?.text).toBe("initial_text\ninitial_text\n");
    });

    // Trigger Save (Ctrl+S) -> historySnapshot resolves immediately, disk writer is called and deferred
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

    await waitFor(() => {
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
        "/repo/app",
        "src/main.ts",
        "initial_text\ninitial_text\n",
        "hash-src/main.ts",
        "UTF-8",
        false,
      );
    });

    // While write is in-flight, user edits buffer further (Ctrl+D)
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-inflight",
      ).openFiles["root:app:src/main.ts"];
      expect(fileState?.text).toBe("initial_text\ninitial_text\ninitial_text\n");
    });

    // Now resolve the disk writer with snapshot result
    await act(async () => {
      resolveWrite(caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file("src/main.ts", "initial_text\ninitial_text\n", { hash: "hash-saved-snapshot" })));
    });

    // Assert writeback merged cleanly: savedText is updated, but buffer text keeps revision 11 edits and dirty is true
    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-inflight",
      ).openFiles["root:app:src/main.ts"];
      expect(fileState?.text).toBe("initial_text\ninitial_text\ninitial_text\n");
      expect(fileState?.savedText).toBe("initial_text\ninitial_text\n");
      expect(fileState?.dirty).toBe(true);
      expect(fileState?.saving).toBe(false);
    });

    expect(useAppStore.getState().statusMessage).toContain("current changes remain unsaved");
    const staleObservation = screen.getByTestId("code-workspace-save-observation");
    expect(staleObservation).toHaveAttribute("data-state", "stale");
    expect(staleObservation).toHaveAttribute("data-result-kind", "saved-stale-snapshot");
    expect(staleObservation).toHaveAttribute("data-dirty", "true");
    expect(staleObservation).toHaveAttribute("data-encoded-bytes-sha256", "hash-saved-snapshot");
    expect(staleObservation).toHaveTextContent("current changes remain unsaved");

    // P0-S3 stale-save ordering: the provider must never receive the stale
    // snapshot text via didSave; only the current buffer may be synced.
    const staleDidSave = caseContext.workspaceTestHarness.lspMocks.lspSaveDocument.mock.calls.some(
      (call) => call.includes("initial_text\ninitial_text\n"),
    );
    expect(staleDidSave).toBe(false);
  });

  it("preserves edits typed while the post-ack watcher notify is awaiting (W2)", async () => {
    // W2 timing: the writer ack has already been delivered, the watcher
    // notify is still awaiting, and the writeback merge has not happened.
    // Edits typed in that window must survive the merge (RISK-01).
    let releaseWatcher: () => void = () => { };
    const watcherDeferred = new Promise<number>((resolve) => {
      releaseWatcher = () => resolve(0);
    });
    caseContext.workspaceTestHarness.lspMocks.lspWorkspaceDidChangeWatchedFiles.mockReturnValue(watcherDeferred);
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
      workspaceId: "ws-save-race-watcher",
      workspaceInstanceId: "instance-save-race-watcher",
      name: "Save Race Watcher",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "initial_text\n"));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();

    // Dirty the buffer (Ctrl+D) so a save transaction can start.
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-watcher",
      ).openFiles["root:app:src/main.ts"];
      expect(fileState?.text).toBe("initial_text\ninitial_text\n");
      expect(fileState?.dirty).toBe(true);
    });

    // Ctrl+S: historySnapshot resolves, the real writer is invoked and its
    // ack is delivered; the commit then awaits the watcher notify.
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      "initial_text\ninitial_text\n",
      "hash-src/main.ts",
      "UTF-8",
      false,
    ));
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspWorkspaceDidChangeWatchedFiles).toHaveBeenCalled());

    // W2 input through the real editor entry: append a single character.
    act(() => {
      view!.dispatch({
        changes: { from: view!.state.doc.length, insert: "X" },
        selection: { anchor: view!.state.doc.length + 1 },
        userEvent: "input.type",
      });
    });
    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-watcher",
      ).openFiles["root:app:src/main.ts"];
      expect(fileState?.text).toBe("initial_text\ninitial_text\nX");
      expect(fileState?.dirty).toBe(true);
    });

    // Release the watcher await; the writeback merge now runs.
    await act(async () => {
      releaseWatcher();
    });

    await waitFor(() => {
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-watcher",
      ).openFiles["root:app:src/main.ts"];
      expect(fileState?.savedText).toBe("initial_text\ninitial_text\n");
      expect(fileState?.text).toBe("initial_text\ninitial_text\nX");
      expect(fileState?.dirty).toBe(true);
      expect(fileState?.saving).toBe(false);
    });
    // The visible editor document must not roll back to the snapshot.
    expect(view!.state.doc.toString()).toBe("initial_text\ninitial_text\nX");

    const staleObservation = screen.getByTestId("code-workspace-save-observation");
    expect(staleObservation).toHaveAttribute("data-state", "stale");
    expect(staleObservation).toHaveAttribute("data-result-kind", "saved-stale-snapshot");
    expect(staleObservation).toHaveAttribute("data-dirty", "true");

    // The provider must never see the snapshot as didSave while the live
    // buffer holds newer text; only the current buffer may be synced.
    expect(caseContext.workspaceTestHarness.lspMocks.lspSaveDocument).not.toHaveBeenCalledWith(
      expect.anything(),
      "initial_text\ninitial_text\n",
    );
  });

  it("QA gate W0: cancels with zero writer calls and keeps the edit typed during the prepare hold", async () => {
    installSaveRaceProbe();
    try {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-gate-w0",
        workspaceInstanceId: "instance-save-gate-w0",
        name: "Save Gate W0",
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
        "instance-save-gate-w0",
      ).openFiles["root:app:src/main.ts"]?.text).toBe("gate_text\ngate_text\n"));

      const control = caseContext.workspaceTestHarness.saveRaceGate();
      expect(control.arm({
        stage: "prepare",
        filePath: "/repo/app/src/main.ts",
        timeoutMs: 15_000,
      })).toMatchObject({ ok: true });
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(control.status().held?.stage).toBe("prepare"));
      // W0: the writer must not have been invoked yet.
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();

      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: "X" },
          selection: { anchor: view!.state.doc.length + 1 },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-gate-w0",
      ).openFiles["root:app:src/main.ts"]?.text).toBe("gate_text\ngate_text\nX"));

      control.release();
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-gate-w0",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.text).toBe("gate_text\ngate_text\nX");
        expect(fileState?.dirty).toBe(true);
        expect(fileState?.saving).toBe(false);
      });
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(useAppStore.getState().statusMessage).toContain("Save cancelled");
      expect(control.trace().map((entryTrace) => entryTrace.event))
        .toEqual(["arm", "enter", "release", "commit-settled"]);
    } finally {
      uninstallSaveRaceProbe();
    }
  });
}
