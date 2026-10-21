import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import { CodeWorkspaceTab } from "../../CodeWorkspaceTab";
import { installSaveRaceProbe, uninstallSaveRaceProbe } from "../saveRaceProbe";
import { acquireClipboardStore, resetWorkspaceClipboardStores } from "../workspaceClipboardSession";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { hasBlockingDiskEffectResolution, listDiskEffectLedgerEntries, resolveDiskEffectLedgerEntry } from "../workspaceRecovery";
import { type registerSaveCasesFixture } from "./save.cases";

export function registerAtomicSaveCases(workspaceTestHarness: registerSaveCasesFixture) {
describe("P0-S / N1.7 Atomic Save Commit Host Race Tests", () => {
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
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(path, initialText));
      workspaceTestHarness.localHistoryMocks.historySnapshot.mockResolvedValue({
        id: 41,
        path: `/repo/app/${path}`,
        contentHash: "history-preimage-hash",
        createdAt: 1_788_888_888,
        reason: "save",
        byteLen: initialText.length,
      });
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        writtenPath: string,
        text: string,
      ) => workspaceTestHarness.writeAck(
        workspaceTestHarness.file(writtenPath, text, { hash: `hash-saved-${writtenPath}` }),
        {
          intentHash: `hash-saved-${writtenPath}`,
          oldHash: `hash-${writtenPath}`,
        },
      ));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
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
      await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
        "/repo/app",
        path,
        savedText,
        `hash-${path}`,
        "UTF-8",
        false,
      ));
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(workspaceTestHarness.saveCommitObservations.results).toHaveLength(1));
      const result = workspaceTestHarness.saveCommitObservations.results[0];
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
      expect((result as { receipt: { receiptId: string; transactionId: string; finalTextSha256: string } }).receipt)
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
      let resolveHistory: () => void = () => {};
      const historyDeferred = new Promise<null>((r) => {
        resolveHistory = () => r(null);
      });
      workspaceTestHarness.localHistoryMocks.historySnapshot.mockReturnValue(historyDeferred);

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-race-history",
        workspaceInstanceId: "instance-save-race-history",
        name: "Save Race History",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "original_v1\n"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
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
        expect(workspaceTestHarness.localHistoryMocks.historySnapshot).toHaveBeenCalled();
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
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteLooseFileEncoded).not.toHaveBeenCalled();
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

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
      let resolveWrite: (res: any) => void = () => {};
      const writeDeferred = new Promise<any>((r) => {
        resolveWrite = r;
      });
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockReturnValue(writeDeferred);

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-race-inflight",
        workspaceInstanceId: "instance-save-race-inflight",
        name: "Save Race InFlight",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "initial_text\n"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
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
        expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
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
        resolveWrite(workspaceTestHarness.writeAck(workspaceTestHarness.file("src/main.ts", "initial_text\ninitial_text\n", { hash: "hash-saved-snapshot" })));
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
      const staleDidSave = workspaceTestHarness.lspMocks.lspSaveDocument.mock.calls.some(
        (call) => call.includes("initial_text\ninitial_text\n"),
      );
      expect(staleDidSave).toBe(false);
    });

    it("preserves edits typed while the post-ack watcher notify is awaiting (W2)", async () => {
      // W2 timing: the writer ack has already been delivered, the watcher
      // notify is still awaiting, and the writeback merge has not happened.
      // Edits typed in that window must survive the merge (RISK-01).
      let releaseWatcher: () => void = () => {};
      const watcherDeferred = new Promise<number>((resolve) => {
        releaseWatcher = () => resolve(0);
      });
      workspaceTestHarness.lspMocks.lspWorkspaceDidChangeWatchedFiles.mockReturnValue(watcherDeferred);
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        writtenPath: string,
        text: string,
      ) => workspaceTestHarness.writeAck(
        workspaceTestHarness.file(writtenPath, text, { hash: `hash-saved-${writtenPath}` }),
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
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "initial_text\n"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
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
      await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
        "/repo/app",
        "src/main.ts",
        "initial_text\ninitial_text\n",
        "hash-src/main.ts",
        "UTF-8",
        false,
      ));
      await waitFor(() => expect(workspaceTestHarness.lspMocks.lspWorkspaceDidChangeWatchedFiles).toHaveBeenCalled());

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
      expect(workspaceTestHarness.lspMocks.lspSaveDocument).not.toHaveBeenCalledWith(
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
        workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
        workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "gate_text\n"));

        const rendered = workspaceTestHarness.renderWorkspace(workspace);
        await screen.findByTitle("app / src/main.ts");
        const content = rendered.container.querySelector<HTMLElement>(".cm-content");
        expect(content).not.toBeNull();
        const view = EditorView.findFromDOM(content!);
        expect(view).not.toBeNull();

        fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
        await waitFor(() => expect(selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-gate-w0",
        ).openFiles["root:app:src/main.ts"]?.text).toBe("gate_text\ngate_text\n"));

        const control = workspaceTestHarness.saveRaceGate();
        expect(control.arm({
          stage: "prepare",
          filePath: "/repo/app/src/main.ts",
          timeoutMs: 15_000,
        })).toMatchObject({ ok: true });
        fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
        await waitFor(() => expect(control.status().held?.stage).toBe("prepare"));
        // W0: the writer must not have been invoked yet.
        expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();

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
        expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
        expect(useAppStore.getState().statusMessage).toContain("Save cancelled");
        expect(control.trace().map((entryTrace) => entryTrace.event))
          .toEqual(["arm", "enter", "release", "commit-settled"]);
      } finally {
        uninstallSaveRaceProbe();
      }
    });

    it("QA gate W1: keeps edits typed after the real writer was invoked and before its ack is delivered", async () => {
      installSaveRaceProbe();
      try {
        workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
          _root: string,
          writtenPath: string,
          text: string,
        ) => workspaceTestHarness.writeAck(
          workspaceTestHarness.file(writtenPath, text, { hash: `hash-saved-${writtenPath}` }),
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
        workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
        workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "gate_text\n"));

        const rendered = workspaceTestHarness.renderWorkspace(workspace);
        await screen.findByTitle("app / src/main.ts");
        const content = rendered.container.querySelector<HTMLElement>(".cm-content");
        expect(content).not.toBeNull();
        const view = EditorView.findFromDOM(content!);
        expect(view).not.toBeNull();

        fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
        await waitFor(() => expect(selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-gate-w1",
        ).openFiles["root:app:src/main.ts"]?.text).toBe("gate_text\ngate_text\n"));

        const control = workspaceTestHarness.saveRaceGate();
        expect(control.arm({
          stage: "ack",
          filePath: "/repo/app/src/main.ts",
          timeoutMs: 15_000,
        })).toMatchObject({ ok: true });
        fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
        await waitFor(() => expect(control.status().held?.stage).toBe("ack"));
        // W1: the real writer was invoked; only its ack delivery is held.
        expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);

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
        workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
          _root: string,
          writtenPath: string,
          text: string,
        ) => workspaceTestHarness.writeAck(
          workspaceTestHarness.file(writtenPath, text, { hash: `hash-saved-${writtenPath}` }),
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
        workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
        workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "gate_text\n"));

        const rendered = workspaceTestHarness.renderWorkspace(workspace);
        await screen.findByTitle("app / src/main.ts");
        const content = rendered.container.querySelector<HTMLElement>(".cm-content");
        expect(content).not.toBeNull();
        const view = EditorView.findFromDOM(content!);
        expect(view).not.toBeNull();

        fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
        await waitFor(() => expect(selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-gate-w2",
        ).openFiles["root:app:src/main.ts"]?.text).toBe("gate_text\ngate_text\n"));

        const control = workspaceTestHarness.saveRaceGate();
        expect(control.arm({
          stage: "watcher",
          filePath: "/repo/app/src/main.ts",
          timeoutMs: 15_000,
        })).toMatchObject({ ok: true });
        fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
        await waitFor(() => expect(control.status().held?.stage).toBe("watcher"));
        // W2: the real writer acked and the real watcher notify was invoked.
        expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
        expect(workspaceTestHarness.lspMocks.lspWorkspaceDidChangeWatchedFiles).toHaveBeenCalledTimes(1);
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
      let resolveWrite: (res: any) => void = () => {};
      const writeDeferred = new Promise<any>((r) => {
        resolveWrite = r;
      });
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockReturnValue(writeDeferred);

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-race-close",
        workspaceInstanceId: "instance-save-race-close",
        name: "Save Race Close",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "close_race\n"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
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
        expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalled();
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
        resolveWrite(workspaceTestHarness.writeAck(workspaceTestHarness.file("src/main.ts", "close_race\nclose_race\n", { hash: "hash-closed-snapshot" })));
      });

      const uiAfter = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-save-race-close");
      expect(uiAfter.openFiles["root:app:src/main.ts"]).toBeUndefined();
      expect(workspaceTestHarness.lspMocks.lspSaveDocument).not.toHaveBeenCalled();

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
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(path, "initial\n"));
      workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(workspaceTestHarness.file(path, "foreign\n", {
        hash: "foreign-disk-hash",
      }));
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("atomic replace acknowledgement was lost"),
        {
          kind: "io",
          effect: "unknown",
          intentHash: "intended-new-hash",
          intentByteLength: 16,
          oldHash: `hash-${path}`,
        },
      ));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-unknown-effect",
      ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save result unknown"));
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
      expect(workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
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
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);

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
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(path, "disk_v1\n"));
      // Native precondition failure (§ED-AUDIT-004 A3): the disk changed under
      // the dirty buffer (external rewrite between load and save). The native
      // writer proves zero bytes landed via effect=none and never fabricates a
      // success receipt.
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("disk hash changed since load"),
        {
          kind: "hash-mismatch",
          expectedHash: `hash-${path}`,
          actualHash: "hash-external-rewrite",
          effect: "none",
        },
      ));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-external-conflict",
      ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save conflict"));
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);

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
      await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2));
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
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(path, "initial\n"));
      // Native unknown-effect contract: the atomic replace acknowledgement was
      // lost, so the error carries the intent hash and old hash but no proof.
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
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
      workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(workspaceTestHarness.file(path, "initial\ninitial\n", {
        hash: "intended-new-hash",
      }));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
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
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
      expect(workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
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
      await waitFor(() => expect(workspaceTestHarness.lspMocks.lspSaveDocument).toHaveBeenCalledWith(
        expect.anything(),
        "initial\ninitial\n",
        expect.anything(),
      ));
    });

    it("reports a verified zero-effect unknown failure and unblocks the retry after read-back", async () => {
      const path = "src/main.ts";
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-unknown-none",
        workspaceInstanceId: "instance-save-unknown-none",
        name: "Save Unknown None",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(path, "initial\n"));
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("atomic replace acknowledgement was lost"),
        {
          kind: "io",
          effect: "unknown",
          intentHash: "intended-new-hash",
          intentByteLength: 16,
          oldHash: `hash-${path}`,
        },
      ));
      // The read-back proves the old bytes are still on disk: nothing landed.
      workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(workspaceTestHarness.file(path, "initial\n"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-unknown-none",
      ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save failed"));
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
      expect(workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
        "/repo/app",
        path,
        "UTF-8",
      );

      const errorObservation = screen.getByTestId("code-workspace-save-observation");
      expect(errorObservation).toHaveAttribute("data-state", "error");
      expect(errorObservation).toHaveAttribute("data-result-kind", "failed");
      expect(errorObservation).toHaveAttribute("data-disk-effect", "none");
      expect(errorObservation).toHaveAttribute("data-dirty", "true");
      expect(errorObservation).not.toHaveAttribute("data-receipt-id");
      expect(errorObservation).not.toHaveAttribute("data-recovery-id");

      // Verified zero effect: no blocking ledger row, and the buffer keeps
      // the user's edits dirty for an ordinary retry.
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-unknown-none",
      ).openFiles[`root:app:${path}`];
      expect(fileState?.dirty).toBe(true);
      expect(fileState?.text).toBe("initial\ninitial\n");
      expect(hasBlockingDiskEffectResolution(
        "instance-save-unknown-none",
        `/repo/app/${path}`,
      )).toBe(false);

      // The retry is unblocked: the next Ctrl+S invokes the writer again.
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2));
    });

    it("§8.27.2 BB1 passes root clipboard handle via WorkspaceClipboardSessionContext to CodeMirror split instances", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-clipboard-bb1",
        workspaceInstanceId: "instance-clipboard-bb1",
        name: "Clipboard Workspace",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (path: string) => {
        if (path === "/repo/app/src/main.ts") return workspaceTestHarness.file("src/main.ts", "content-in-main\n");
        return workspaceTestHarness.file("src/util.ts", "content-in-util\n");
      });

      workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");

      // Verify that the clipboard store was acquired and is active for this workspaceInstanceId
      const store = acquireClipboardStore("instance-clipboard-bb1");
      const snap = store.getSnapshot();
      expect(snap.consumerCount).toBeGreaterThanOrEqual(1);
      expect(snap.permissionGeneration).toBe(1);

      // Write to the workspace clipboard handle
      store.write({
        sourceViewId: null,
        plainText: "copied-across-split",
        rectangular: false,
        sourceEol: "lf",
      });

      expect(store.read()?.plainText).toBe("copied-across-split");
      store.release();
    });

    it("ED-CLIP-003: cross-split multi-caret copy in primary and paste in secondary with single undo (different files)", async () => {
      resetWorkspaceClipboardStores();
      const baselineConsumerCount = 0;
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-clip-split-diff",
        workspaceInstanceId: "instance-clip-split-diff",
        name: "Different Files Split",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
        path === "src/util.ts" || path === "/repo/app/src/util.ts"
          ? workspaceTestHarness.file("src/util.ts", "let a = 0;\nlet b = 0;\n")
          : workspaceTestHarness.file("src/main.ts", "const x = 10;\nconst y = 20;\n")
      ));

      window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-clip-split-diff", JSON.stringify({
        version: 1,
        splitOrientation: "vertical",
        activeEditorGroupId: "primary",
        editorGroups: {
          primary: {
            openOrder: ["root:app:src/main.ts"],
            activeKey: "root:app:src/main.ts",
            previewKey: null,
            pinnedKeys: [],
          },
          secondary: {
            openOrder: ["root:app:src/util.ts"],
            activeKey: "root:app:src/util.ts",
            previewKey: null,
            pinnedKeys: [],
          },
        },
      }));

      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        registrationRef.current = next;
      });

      const { unmount } = workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      await screen.findByTitle("app / src/util.ts");

      const panes = screen.getAllByTestId("code-workspace-editor-pane");
      const primaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "primary");
      const secondaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "secondary");
      const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
      const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");

      expect(primaryEditor).not.toBeNull();
      expect(secondaryEditor).not.toBeNull();
      const primaryView = EditorView.findFromDOM(primaryEditor!);
      const secondaryView = EditorView.findFromDOM(secondaryEditor!);
      expect(primaryView).not.toBeNull();
      expect(secondaryView).not.toBeNull();

      // Assert consumer lease count: both splits hold active leases with distinct tokens
      const store = acquireClipboardStore("instance-clip-split-diff");
      const snap = store.getSnapshot();
      expect(snap.consumerCount).toBe(2);
      expect(snap.consumers[0].token).not.toBe(snap.consumers[1].token);

      // Select 2 segments in primary view (src/main.ts)
      primaryView!.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(0, 13), // "const x = 10;"
          EditorSelection.range(14, 27), // "const y = 20;"
        ], 0),
      });

      // Focus primary pane and execute copy
      fireEvent.mouseDown(primaryPane!);
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-clip-split-diff").activeEditorGroupId,
      ).toBe("primary"));
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.copy")?.enabled,
      ).toBe(true));

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.copy");
      });

      // Assert copied payload in workspace session
      const session = store.read();
      expect(session).not.toBeNull();
      expect(session?.segments).toEqual(["const x = 10;", "const y = 20;"]);
      expect(session?.plainText).toBe("const x = 10;\nconst y = 20;");

      // Place 2 carets in secondary view (src/util.ts)
      secondaryView!.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(0), // before "let a = 0;"
          EditorSelection.cursor(11), // before "let b = 0;"
        ], 0),
      });
      const destinationSelectionBeforePaste = secondaryView!.state.selection;
      expect(destinationSelectionBeforePaste.ranges.map((range) => range.head)).toEqual([0, 11]);

      // Focus secondary pane and execute paste
      fireEvent.mouseDown(secondaryPane!);
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-clip-split-diff").activeEditorGroupId,
      ).toBe("secondary"));
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.paste")?.enabled,
      ).toBe(true));

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.paste");
      });

      // Assert target text in secondary view has distributed segments
      await waitFor(() => {
        expect(secondaryView!.state.doc.toString()).toBe("const x = 10;let a = 0;\nconst y = 20;let b = 0;\n");
        expect(secondaryView!.state.selection.ranges.map((range) => range.head)).toEqual([13, 37]);
        expect(primaryView!.state.doc.toString()).toBe("const x = 10;\nconst y = 20;\n");
      });

      // Single undo restores pre-paste state. Drive the production entry
      // (Ctrl+Z -> workspace.undo -> shared transaction owner): a shared
      // document has no local CodeMirror history() to undo.
      fireEvent.keyDown(secondaryPane!, { key: "z", ctrlKey: true });
      await waitFor(() => {
        expect(secondaryView!.state.doc.toString()).toBe("let a = 0;\nlet b = 0;\n");
        expect(secondaryView!.state.selection.eq(destinationSelectionBeforePaste, true)).toBe(true);
      });

      store.release();
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // After workspace unmount, consumer leases and slot are cleaned up
      const afterStore = acquireClipboardStore("instance-clip-split-diff");
      expect(afterStore.getSnapshot().consumerCount).toBe(baselineConsumerCount);
      expect(afterStore.read()).toBeNull();
      afterStore.release();
      resetWorkspaceClipboardStores();
    });

    it("ED-CLIP-004: projects typed copy/paste outcome, OS effect and fallback into the clipboard observation seam", async () => {
      resetWorkspaceClipboardStores();
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-clip-observe",
        workspaceInstanceId: "instance-clip-observe",
        name: "Clipboard Observation",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async () => (
        workspaceTestHarness.file("src/main.ts", "const x = 10;\nconst y = 20;\n")
      ));

      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        registrationRef.current = next;
      });

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");

      const observation = screen.getByTestId("code-workspace-clipboard-observation");
      // Live-region semantics exist before any clipboard operation ran.
      expect(observation.getAttribute("role")).toBe("status");
      expect(observation.getAttribute("aria-live")).toBe("polite");
      expect(observation.getAttribute("aria-label")).toBe("Clipboard status");
      expect(observation.getAttribute("data-outcome")).toBeNull();

      const pane = screen.getAllByTestId("code-workspace-editor-pane")[0];
      const view = EditorView.findFromDOM(pane.querySelector<HTMLElement>(".cm-editor")!);
      expect(view).not.toBeNull();

      // Two carets so the seam reports the real multi-caret shape.
      view!.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(0, 13),
          EditorSelection.range(14, 27),
        ], 0),
      });
      fireEvent.mouseDown(pane);
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.copy")?.enabled,
      ).toBe(true));
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.copy");
      });

      await waitFor(() => {
        expect(observation.getAttribute("data-operation")).toBe("copy");
        expect(observation.getAttribute("data-outcome")).toBe("success");
        expect(observation.getAttribute("data-system-effect")).toBe("performed");
      });
      expect(observation.getAttribute("data-segment-count")).toBe("2");
      expect(observation.getAttribute("data-caret-count")).toBe("2");
      expect(observation.getAttribute("data-payload-length")).toBe(
        String("const x = 10;\nconst y = 20;".length),
      );
      expect(observation.getAttribute("data-workspace-fallback")).toBe("false");
      // Metadata only: the copied text never reaches the DOM seam.
      expect(observation.outerHTML).not.toContain("const x = 10;");
      expect(observation.textContent).toContain("system clipboard effect performed");

      // Real OS read failure: the workspace slot answers and the seam reports
      // unavailable + unknown effect + a visible fallback, never success.
      // mockImplementationOnce, restored below: a leftover queued *Once value
      // would otherwise leak into a later test's clipboard read.
      const defaultNativeReadTextResult = workspaceTestHarness.clipboardMocks.readNativeTextResult.getMockImplementation();
      workspaceTestHarness.runtimeState.tauri = true;
      workspaceTestHarness.clipboardMocks.readNativeTextResult.mockImplementationOnce(async () => ({ ok: false, text: "" }));
      workspaceTestHarness.clipboardMocks.readTextResult.mockClear();
      view!.dispatch({ selection: EditorSelection.single(0) });
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.paste")?.enabled,
      ).toBe(true));
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.paste");
      });

      await waitFor(() => {
        expect(observation.getAttribute("data-operation")).toBe("paste");
        expect(observation.getAttribute("data-outcome")).toBe("unavailable");
      });
      expect(observation.getAttribute("data-system-effect")).toBe("unknown");
      expect(observation.getAttribute("data-workspace-fallback")).toBe("true");
      expect(observation.textContent).toContain("workspace clipboard slot");
      expect(workspaceTestHarness.clipboardMocks.readNativeTextResult).toHaveBeenCalledTimes(1);
      expect(workspaceTestHarness.clipboardMocks.readTextResult).not.toHaveBeenCalled();
      // The fallback really inserted the payload rather than reporting success.
      expect(view!.state.doc.toString()).toContain("const x = 10;\nconst y = 20;const x = 10;");

      // Drain any unconsumed one-shot and restore the shared mock so this test
      // cannot alter a later test's clipboard behaviour.
      workspaceTestHarness.clipboardMocks.readNativeTextResult.mockReset();
      if (defaultNativeReadTextResult) {
        workspaceTestHarness.clipboardMocks.readNativeTextResult.mockImplementation(defaultNativeReadTextResult);
      }
      resetWorkspaceClipboardStores();
    });

    it("ED-CLIP-003: cross-split copy/paste with same-file dual split under StrictMode", async () => {
      resetWorkspaceClipboardStores();
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-clip-split-same",
        workspaceInstanceId: "instance-clip-split-same",
        name: "Same File Split",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
        workspaceTestHarness.file("src/main.ts", "line1: alpha\nline2: beta\nline3: gamma\n")
      ));

      window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-clip-split-same", JSON.stringify({
        version: 1,
        splitOrientation: "vertical",
        activeEditorGroupId: "primary",
        editorGroups: {
          primary: {
            openOrder: ["root:app:src/main.ts"],
            activeKey: "root:app:src/main.ts",
            previewKey: null,
            pinnedKeys: [],
          },
          secondary: {
            openOrder: ["root:app:src/main.ts"],
            activeKey: "root:app:src/main.ts",
            previewKey: null,
            pinnedKeys: [],
          },
        },
      }));

      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        registrationRef.current = next;
      });

      const { unmount } = render(
        <StrictMode>
          <CodeWorkspaceTab
            tabId="code-strict-split"
            workspace={workspace}
            onCommandsChange={onCommandsChange}
          />
        </StrictMode>,
      );
      await screen.findAllByTitle("app / src/main.ts");

      const panes = screen.getAllByTestId("code-workspace-editor-pane");
      const primaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "primary");
      const secondaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "secondary");
      const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
      const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");

      const primaryView = EditorView.findFromDOM(primaryEditor!);
      const secondaryView = EditorView.findFromDOM(secondaryEditor!);
      expect(primaryView).not.toBeNull();
      expect(secondaryView).not.toBeNull();

      const store = acquireClipboardStore("instance-clip-split-same");
      expect(store.getSnapshot().consumerCount).toBe(2);

      // Select line 1 in primary view
      primaryView!.dispatch({
        selection: EditorSelection.range(0, 12), // "line1: alpha"
      });

      fireEvent.mouseDown(primaryPane!);
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.copy")?.enabled,
      ).toBe(true));

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.copy");
      });

      expect(store.read()?.plainText).toBe("line1: alpha");

      // Select line 3 in secondary view and paste
      secondaryView!.dispatch({
        selection: EditorSelection.range(25, 37), // "line3: gamma"
      });

      fireEvent.mouseDown(secondaryPane!);
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.paste")?.enabled,
      ).toBe(true));

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.paste");
      });

      await waitFor(() => {
        expect(secondaryView!.state.doc.toString()).toBe("line1: alpha\nline2: beta\nline1: alpha\n");
      });

      // Undo in secondary view through the production entry.
      fireEvent.keyDown(secondaryPane!, { key: "z", ctrlKey: true });
      await waitFor(() => {
        expect(secondaryView!.state.doc.toString()).toBe("line1: alpha\nline2: beta\nline3: gamma\n");
      });

      store.release();
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
      resetWorkspaceClipboardStores();
    });
  });
}
