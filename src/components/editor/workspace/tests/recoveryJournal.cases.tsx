import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog, promptAppDialog } from "../../../../lib/appDialogs";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import { sha256Hex } from "../projectAnalysisModel";
import { getRefactorRecoveryJournalV2, recordRefactorRecoveryJournalV2 } from "../refactorPlan";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "./workspaceEdits.cases";

export function registerRecoveryJournalCases(workspaceTestHarness: registerWorkspaceEditsCasesFixture) {
describe("ED-AUDIT-014: refactor recovery journal", () => {
    const RECOVERY_V2_PREFIX = "taomni.refactor.recovery.v2:";
    // Simulated disk keyed by root-relative path. The rename edits both files:
    // main.ts is the open buffer, other.ts is a closed disk file.
    const PRE: Record<string, string> = {
      "src/main.ts": "alpha = 1",
      "src/other.ts": "alpha = 2",
      "src/reader.ts": "reader",
    };
    const POST: Record<string, string> = {
      "src/main.ts": "omega = 1",
      "src/other.ts": "omega = 2",
    };

    interface RecoveryFixture {
      disk: Record<string, string>;
      workspace: CodeWorkspaceTabInfo;
      registrationRef: { current: WorkspaceCommandRegistration | null };
      onCommandsChange: (tabId: string, next: WorkspaceCommandRegistration | null) => void;
    }

    /** Simulated workspace disk: reads and encoded writes hit one shared map. */
    function setupWorkspace(instanceId: string, openFile: string): RecoveryFixture {
      const disk: Record<string, string> = { ...PRE };
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: `instance-${instanceId}`,
        name: instanceId,
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: openFile },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => workspaceTestHarness.entry(rel.split("/").pop()!, rel))
          : [workspaceTestHarness.entry("src", "src", "dir")]
      ));
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return workspaceTestHarness.file(path, disk[path]);
      });
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange };
    }

    /**
     * Provider rename fixture: renames `alpha` to `omega` in the open document
     * and in the closed sibling. The rename-symbol flow is the journal-gated
     * production path (code actions manage their own adapter transaction with
     * recordHistory disabled, so they intentionally do not journal here).
     */
    function mockTwoFileRename(): void {
      const status = workspaceTestHarness.documentStatus({
        path: "/repo/app/src/main.ts",
        uri: "file:///repo/app/src/main.ts",
        available: true,
        active: true,
        capabilities: workspaceTestHarness.defaultCapabilities({ rename: true }),
      });
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
      workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(status);
      workspaceTestHarness.lspMocks.lspPrepareRename.mockResolvedValue({
        status,
        allowed: true,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        placeholder: "alpha",
        message: null,
      });
      workspaceTestHarness.lspMocks.lspRename.mockResolvedValue({
        status,
        edit: {
          documentEdits: [
            {
              uri: "file:///repo/app/src/main.ts",
              path: "/repo/app/src/main.ts",
              edits: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                newText: "omega",
              }],
            },
            {
              uri: "file:///repo/app/src/other.ts",
              path: "/repo/app/src/other.ts",
              edits: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                newText: "omega",
              }],
            },
          ],
        },
      });
    }

    /** Drives Rename Symbol -> new name -> preview confirm. */
    async function runRename(
      registrationRef: RecoveryFixture["registrationRef"],
    ): Promise<void> {
      vi.mocked(promptAppDialog).mockResolvedValue("omega");
      await registrationRef.current!.executeAction("workspace.renameSymbol");
      const preview = await screen.findByTestId("refactoring-preview-dialog");
      fireEvent.click(within(preview).getByTestId("refactoring-preview-apply"));
    }

    function recoveryDocument(
      uri: string,
      canonicalPath: string,
      preText: string,
      postText: string,
    ) {
      return {
        uri,
        canonicalPath,
        preText,
        preHash: sha256Hex(preText),
        postText,
        postHash: sha256Hex(postText),
        encoding: "UTF-8",
        bom: false,
        eol: "lf" as const,
      };
    }

    function seedPendingJournal(): void {
      const result = recordRefactorRecoveryJournalV2({
        schemaVersion: 2,
        recoveryId: "rec-reopen-1",
        transactionId: "tx-reopen-1",
        actionId: "rename:update-two-files",
        kind: "rename",
        workspaceRoot: "/repo/app",
        createdAt: 100,
        updatedAt: 200,
        status: "recovery-required",
        appliedOperationIndex: null,
        documents: [
          recoveryDocument("file:///repo/app/src/main.ts", "/repo/app/src/main.ts", PRE["src/main.ts"], POST["src/main.ts"]),
          recoveryDocument("file:///repo/app/src/other.ts", "/repo/app/src/other.ts", PRE["src/other.ts"], POST["src/other.ts"]),
        ],
        resourceMoves: [],
        verification: { mismatchedUris: [], checkedAt: null },
      });
      expect(result.ok).toBe(true);
    }

    function storedRecoveryEntries(): Array<{
      key: string;
      entry: { status: string; verification: { mismatchedUris: string[] } };
    }> {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(RECOVERY_V2_PREFIX))
        .map((key) => ({ key, entry: JSON.parse(window.localStorage.getItem(key)!) }));
    }

    function recoveryCalls(): Array<{ title: string; message: string }> {
      return vi.mocked(confirmAppDialog).mock.calls.map((call) => ({
        title: (call[0] as { title: string }).title,
        message: (call[0] as { message: string }).message,
      }));
    }

    function undoItem(registrationRef: RecoveryFixture["registrationRef"]) {
      return registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit");
    }

    /**
     * jsdom's Storage instance cannot be spied reliably, so tests that must
     * observe or fail journal writes swap in a recording Storage fake.
     */
    function installRecordingStorage(
      onWrite?: (key: string, value: string) => void,
    ): { restore: () => void; keys: () => string[] } {
      const backing = new Map<string, string>();
      const fake: Storage = {
        get length() { return backing.size; },
        clear: () => backing.clear(),
        getItem: (k) => backing.get(k) ?? null,
        key: (i) => Array.from(backing.keys())[i] ?? null,
        removeItem: (k) => { backing.delete(k); },
        setItem: (k, v) => { onWrite?.(k, v); backing.set(k, v); },
      };
      const original = window.localStorage;
      Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
      return {
        restore: () => Object.defineProperty(window, "localStorage", { value: original, configurable: true, writable: true }),
        keys: () => Array.from(backing.keys()),
      };
    }

    it("closes a postcondition-mismatched transaction as recovery-required without success history", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("recovery-mismatch", "src/main.ts");
      mockTwoFileRename();
      // A concurrent writer wins the race on the closed file: the write ack
      // says committed, but the on-disk post-state is third-party content.
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        _text: string,
      ) => {
        disk[path] = "third-party edit";
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, "third-party edit", { hash: "hash-third-party" }));
      });

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await runRename(registrationRef);

      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("recovery required"));
      expect(useAppStore.getState().statusMessage).toContain("Refactor postcondition failed");
      expect(useAppStore.getState().statusMessage).toContain("mismatch on /repo/app/src/other.ts");
      expect(useAppStore.getState().statusMessage).toContain("Applied changes on: /repo/app/src/main.ts, /repo/app/src/other.ts");
      // The applied changes stay; nothing is rolled back silently.
      expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-recovery-mismatch",
      ).openFiles["root:app:src/main.ts"]?.text).toBe(POST["src/main.ts"]);
      // No normal success history: undo stays unavailable.
      expect(undoItem(registrationRef)?.enabled).toBe(false);
      // The pending journal records the mismatch for recovery.
      const entries = storedRecoveryEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entry.status).toBe("recovery-required");
      expect(entries[0]!.entry.verification.mismatchedUris).toContain("file:///repo/app/src/other.ts");
    });

    it("aborts with zero writes when the recovery journal cannot be persisted", async () => {
      const { workspace, registrationRef, onCommandsChange } = setupWorkspace("recovery-quota", "src/main.ts");
      mockTwoFileRename();
      const storage = installRecordingStorage((key) => {
        if (key.startsWith(RECOVERY_V2_PREFIX)) throw new Error("quota exceeded");
      });

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await runRename(registrationRef);

      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "Refactor recovery journal could not be persisted, no changes were applied",
      ));
      expect(useAppStore.getState().statusMessage).toContain("quota exceeded");
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-recovery-quota",
      ).openFiles["root:app:src/main.ts"]?.text).toBe(PRE["src/main.ts"]);
      expect(undoItem(registrationRef)?.enabled).toBe(false);
      expect(storage.keys().filter((key) => key.startsWith(RECOVERY_V2_PREFIX))).toHaveLength(0);
      storage.restore();
    });

    it("prepares the journal before the first mutation, commits it after verified postconditions, and supports undo/redo", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("recovery-order", "src/reader.ts");
      mockTwoFileRename();
      // Recording storage fake: jsdom's Storage cannot be spied reliably, so
      // writes are observed (and values captured) through the fake itself.
      const events: Array<{ kind: string; key: string; value: string }> = [];
      const storage = installRecordingStorage((key, value) => {
        events.push({ kind: key.startsWith(RECOVERY_V2_PREFIX) ? "journal" : "other", key, value });
      });
      const writeMock = workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        events.push({ kind: "disk-write", key: path, value: text });
        disk[path] = text;
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await runRename(registrationRef);

      await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(2));
      const journalEventIndex = events.findIndex((event) => event.kind === "journal");
      const firstWriteIndex = events.findIndex((event) => event.kind === "disk-write");
      expect(journalEventIndex).toBeGreaterThanOrEqual(0);
      expect(firstWriteIndex).toBeGreaterThan(journalEventIndex);
      // The prepared entry (captured at write time, before the later committed
      // patch overwrites the same key) is what precedes mutation.
      const journalEvent = events[journalEventIndex]!;
      const journalKey = journalEvent.key;
      expect(JSON.parse(journalEvent.value)).toMatchObject({ status: "prepared" });

      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Applied 2"));
      expect(getRefactorRecoveryJournalV2(journalKey.slice(RECOVERY_V2_PREFIX.length))?.status).toBe("committed");
      expect(disk["src/main.ts"]).toBe(POST["src/main.ts"]);
      expect(disk["src/other.ts"]).toBe(POST["src/other.ts"]);

      // ED-AUDIT-008: the journal action is focus-gated off the editor surface;
      // the recovery stroke is taken from non-editor focus (window target).
      // "Applied 2" is set after the journal entry is pushed, so it is the
      // readiness signal for an undoable transaction.
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Applied 2"));
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await workspaceTestHarness.confirmWorkspaceUndo();
      await waitFor(() => expect(disk["src/main.ts"]).toBe(PRE["src/main.ts"]));
      await waitFor(() => expect(disk["src/other.ts"]).toBe(PRE["src/other.ts"]));

      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(disk["src/main.ts"]).toBe(POST["src/main.ts"]));
      await waitFor(() => expect(disk["src/other.ts"]).toBe(POST["src/other.ts"]));
      storage.restore();
    });

    it("blocks undo when a later edit changed a recorded file and protects that edit", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("recovery-undo-block", "src/reader.ts");
      mockTwoFileRename();

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await runRename(registrationRef);
      await waitFor(() => expect(disk["src/other.ts"]).toBe(POST["src/other.ts"]));

      // ED-AUDIT-008: "Applied 2" is set after the journal entry is pushed, so
      // it is the readiness signal; the undo stroke is taken from non-editor
      // focus (window target) because the journal action is focus-gated off
      // the editor surface.
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Applied 2"));
      // A later edit lands on one recorded file before the user undoes.
      disk["src/other.ts"] = "later third-party edit";
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await workspaceTestHarness.confirmWorkspaceUndo();
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "Cannot undo workspace edit: Undo blocked to protect later edits",
      ));
      expect(useAppStore.getState().statusMessage).toContain("/repo/app/src/other.ts");
      // Zero overwrite: the later edit and the other recorded file are intact.
      expect(disk["src/other.ts"]).toBe("later third-party edit");
      expect(disk["src/main.ts"]).toBe(POST["src/main.ts"]);
    });

    it("restores pending recovery entries through the real UI after reopen", async () => {
      workspaceTestHarness.runtimeState.tauri = true;
      const { disk, workspace } = setupWorkspace("recovery-restore", "src/main.ts");
      // The interrupted transaction already applied its post-state on disk.
      disk["src/main.ts"] = POST["src/main.ts"];
      disk["src/other.ts"] = POST["src/other.ts"];
      seedPendingJournal();

      workspaceTestHarness.renderWorkspace(workspace, {});
      await screen.findByTitle("app / src/main.ts");
      // RC-02: auto-discover opens the review dialog (figure A) instead of a
      // global confirm. Restore via the dialog; the second confirm reuses the
      // mocked app dialog (default true).
      const review = await screen.findByTestId("refactor-recovery-review");
      expect(within(review).getAllByTestId("refactor-recovery-resource")).toHaveLength(2);
      const restoreButton = within(review).getByTestId("refactor-recovery-restore");
      await waitFor(() => expect(restoreButton).toBeEnabled());
      fireEvent.click(restoreButton);

      await waitFor(() => expect(disk["src/main.ts"]).toBe(PRE["src/main.ts"]));
      await waitFor(() => expect(disk["src/other.ts"]).toBe(PRE["src/other.ts"]));
      expect(getRefactorRecoveryJournalV2("rec-reopen-1")?.status).toBe("rolled-back");
      expect(useAppStore.getState().statusMessage).toContain("Refactor recovery complete: restored 2");

      // Windows can deliver the restore-owned delete half of a rename after
      // the buffer has already been remapped/opened at the restored path.
      await act(async () => {
        await emit("lsp://external-file-change", {
          workspaceId: "instance-recovery-restore",
          path: "/repo/app/src/main.ts",
          type: 3,
        });
        await new Promise((resolve) => setTimeout(resolve, 240));
      });
      expect(useAppStore.getState().statusMessage).toContain("Refactor recovery complete: restored 2");
      expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-recovery-restore",
      ).openFiles["root:app:src/main.ts"]?.error).toBeNull();
    });

    it("closes an already-restored pending entry idempotently without rewriting files", async () => {
      const { disk, workspace } = setupWorkspace("recovery-idempotent", "src/reader.ts");
      // Disk is already at the pre-refactor content (someone restored it).
      seedPendingJournal();

      workspaceTestHarness.renderWorkspace(workspace, {});
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "already matches its pre-refactor content",
      ));
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(disk["src/main.ts"]).toBe(PRE["src/main.ts"]);
      expect(getRefactorRecoveryJournalV2("rec-reopen-1")?.status).toBe("rolled-back");
    });

    it("keeps conflicting files untouched and the entry pending", async () => {
      const { disk, workspace } = setupWorkspace("recovery-conflict", "src/reader.ts");
      disk["src/main.ts"] = POST["src/main.ts"];
      disk["src/other.ts"] = "user edited after the refactor";
      seedPendingJournal();

      workspaceTestHarness.renderWorkspace(workspace, {});
      await screen.findByTitle("app / src/reader.ts");
      // RC-02: conflicted entries render in the review dialog with restore
      // disabled and an explicit keep outlet; nothing is overwritten.
      const review = await screen.findByTestId("refactor-recovery-review");
      expect(within(review).getByTestId("refactor-recovery-restore")).toBeDisabled();
      expect(review.textContent).toContain("other.ts");
      fireEvent.click(within(review).getByTestId("refactor-recovery-keep"));
      await waitFor(() => expect(screen.queryByTestId("refactor-recovery-review")).not.toBeInTheDocument());
      // Zero overwrite: the third-party content and the post-state stay as-is.
      expect(disk["src/other.ts"]).toBe("user edited after the refactor");
      expect(disk["src/main.ts"]).toBe(POST["src/main.ts"]);
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(getRefactorRecoveryJournalV2("rec-reopen-1")?.status).toBe("recovery-required");
    });

    it("abandons a both-missing entry with zero file writes and keeps siblings pending", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("recovery-abandon", "src/reader.ts");
      // Sibling stays restorable on disk; the abandoned record points at files
      // that exist at neither end (deleted-after-rename shape).
      disk["src/main.ts"] = POST["src/main.ts"];
      disk["src/other.ts"] = POST["src/other.ts"];
      const gonePre = "gone pre";
      const gonePost = "gone post";
      expect(recordRefactorRecoveryJournalV2({
        schemaVersion: 2,
        recoveryId: "rec-abandon-1",
        transactionId: "tx-abandon-1",
        actionId: "rename:gone",
        kind: "rename",
        workspaceRoot: "/repo/app",
        createdAt: 200,
        updatedAt: 200,
        status: "recovery-required",
        appliedOperationIndex: null,
        documents: [recoveryDocument(
          "file:///repo/app/src/Gone.java",
          "/repo/app/src/Gone.java",
          gonePre,
          gonePost,
        )],
        resourceMoves: [{
          oldUri: "file:///repo/app/src/Gone.java",
          newUri: "file:///repo/app/src/GoneRenamed.java",
          oldPath: "/repo/app/src/Gone.java",
          newPath: "/repo/app/src/GoneRenamed.java",
          contentHash: sha256Hex(gonePre),
        }],
        verification: { mismatchedUris: [], checkedAt: null },
      }).ok).toBe(true);
      expect(recordRefactorRecoveryJournalV2({
        schemaVersion: 2,
        recoveryId: "rec-sibling-1",
        transactionId: "tx-sibling-1",
        actionId: "rename:update-two-files",
        kind: "rename",
        workspaceRoot: "/repo/app",
        createdAt: 100,
        updatedAt: 100,
        status: "recovery-required",
        appliedOperationIndex: null,
        documents: [
          recoveryDocument("file:///repo/app/src/main.ts", "/repo/app/src/main.ts", PRE["src/main.ts"], POST["src/main.ts"]),
          recoveryDocument("file:///repo/app/src/other.ts", "/repo/app/src/other.ts", PRE["src/other.ts"], POST["src/other.ts"]),
        ],
        resourceMoves: [],
        verification: { mismatchedUris: [], checkedAt: null },
      }).ok).toBe(true);

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/reader.ts");
      // Newest first: the both-missing record reviews first with restore disabled.
      const abandonReview = await screen.findByTestId("refactor-recovery-review");
      expect(abandonReview.textContent).toContain("Gone.java");
      expect(within(abandonReview).getByTestId("refactor-recovery-restore")).toBeDisabled();
      fireEvent.click(within(abandonReview).getByTestId("refactor-recovery-dismiss"));
      fireEvent.click(await screen.findByTestId("refactor-recovery-dismiss-confirm-button"));
      // Dismissal writes only the resolution marker: zero file writes, files
      // stay exactly as they are (deleted stays deleted, sibling post intact).
      await waitFor(() => expect(getRefactorRecoveryJournalV2("rec-abandon-1")?.resolution).toEqual({
        kind: "user-dismissed",
        resolvedAt: expect.any(Number),
        reason: "keep-current-state",
      }));
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(disk["src/main.ts"]).toBe(POST["src/main.ts"]);
      expect(disk["src/other.ts"]).toBe(POST["src/other.ts"]);
      expect(useAppStore.getState().statusMessage).toContain("Abandoned refactor recovery");
      // The sibling still prompts after the abandon (same discover loop).
      const siblingReview = await screen.findByTestId("refactor-recovery-review");
      expect(siblingReview.textContent).toContain("main.ts");
      expect(siblingReview.textContent).not.toContain("Gone.java");
      fireEvent.click(within(siblingReview).getByTestId("refactor-recovery-keep"));
      await waitFor(() => expect(screen.queryByTestId("refactor-recovery-review")).not.toBeInTheDocument());
      expect(getRefactorRecoveryJournalV2("rec-sibling-1")?.status).toBe("recovery-required");
      expect(getRefactorRecoveryJournalV2("rec-sibling-1")?.resolution).toBeUndefined();

      // Re-review surfaces only the sibling; the abandoned record never returns.
      const rerun = registrationRef.current?.executeAction("workspace.reviewRefactorRecovery");
      const secondLook = await screen.findByTestId("refactor-recovery-review");
      expect(secondLook.textContent).toContain("main.ts");
      expect(secondLook.textContent).not.toContain("Gone.java");
      fireEvent.click(within(secondLook).getByTestId("refactor-recovery-keep"));
      await rerun;
    });

    it("never replays legacy v1 recovery journals", async () => {
      const { workspace } = setupWorkspace("recovery-legacy", "src/reader.ts");
      window.localStorage.setItem(
        "taomni.refactor.recovery.v1:legacy-1",
        JSON.stringify({ schemaVersion: 1, recoveryId: "legacy-1", status: "pending" }),
      );

      workspaceTestHarness.renderWorkspace(workspace, {});
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      // Let every pending microtask/discovery pass settle.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(recoveryCalls().filter((call) => call.title === "Refactor recovery pending")).toHaveLength(0);
      expect(window.localStorage.getItem("taomni.refactor.recovery.v1:legacy-1")).not.toBeNull();
      expect(Object.keys(window.localStorage).filter((key) => key.startsWith(RECOVERY_V2_PREFIX))).toHaveLength(0);
    });
  });
describe("ED-REPAIR-004: plan-less workspace edit recovery journal", () => {
    const RECOVERY_V2_PREFIX = "taomni.refactor.recovery.v2:";
    const PRE: Record<string, string> = {
      "src/a.ts": "hello alpha",
      "src/b.ts": "hello beta",
      "src/c.ts": "reader",
    };

    interface Fixture {
      disk: Record<string, string>;
      workspace: CodeWorkspaceTabInfo;
      registrationRef: { current: WorkspaceCommandRegistration | null };
      onCommandsChange: (tabId: string, next: WorkspaceCommandRegistration | null) => void;
    }

    function setupWorkspace(instanceId: string, openFile: string): Fixture {
      const disk: Record<string, string> = { ...PRE };
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: `instance-${instanceId}`,
        name: instanceId,
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: openFile },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => workspaceTestHarness.entry(rel.split("/").pop()!, rel))
          : [workspaceTestHarness.entry("src", "src", "dir")]
      ));
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return workspaceTestHarness.file(path, disk[path]!);
      });
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange };
    }

    function storedRecoveryEntries(): Array<{
      key: string;
      entry: {
        recoveryId: string;
        status: string;
        kind: string;
        verification?: {
          mismatchedUris: readonly string[];
          appliedEffects?: readonly string[];
          failedEffects?: readonly unknown[];
        };
      };
    }> {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(RECOVERY_V2_PREFIX))
        .map((key) => ({ key, entry: JSON.parse(window.localStorage.getItem(key)!) }));
    }

    function undoItem(registrationRef: Fixture["registrationRef"]) {
      return registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit");
    }

    function installRecordingStorage(
      onWrite?: (key: string, value: string) => void,
    ): { restore: () => void; keys: () => string[] } {
      const backing = new Map<string, string>();
      const fake: Storage = {
        get length() { return backing.size; },
        clear: () => backing.clear(),
        getItem: (k) => backing.get(k) ?? null,
        key: (i) => Array.from(backing.keys())[i] ?? null,
        removeItem: (k) => { backing.delete(k); },
        setItem: (k, v) => { onWrite?.(k, v); backing.set(k, v); },
      };
      const original = window.localStorage;
      Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
      return {
        restore: () => Object.defineProperty(window, "localStorage", { value: original, configurable: true, writable: true }),
        keys: () => Array.from(backing.keys()),
      };
    }

    async function applyEditWithPreview(workspaceId: string | undefined, edit: unknown, label = "Replace all matches") {
      expect(workspaceId).toBeDefined();
      void emit("lsp://workspace-apply-edit", {
        requestId: `req-${Date.now()}`,
        workspaceId: workspaceId!,
        edit,
        label,
      });
      const preview = await screen.findByTestId("refactoring-preview-dialog");
      fireEvent.click(within(preview).getByTestId("refactoring-preview-apply"));
    }

    it("refuses text mutations when recovery snapshots cannot be captured", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("missing-snapshots", "src/c.ts");
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockRejectedValue(new Error("listing unavailable"));
      await act(async () => {
        await emit("lsp://workspace-apply-edit", {
          requestId: "missing-snapshots", workspaceId: workspace.workspaceInstanceId,
          edit: { documentEdits: [{ uri: "file:///repo/app/src/a.ts", path: "/repo/app/src/a.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }] }] },
        });
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toMatch(/preimage|snapshot/i));
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]);
    });

    it("retries successive failure boundaries against the full confirmed plan and undoes all files", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("successive-retries", "src/c.ts");
      disk["src/d.ts"] = "hello delta";
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
      const attempts = new Map<string, number>();
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (_root: string, path: string, text: string) => {
        const attempt = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, attempt);
        if ((path === "src/b.ts" || path === "src/d.ts") && attempt === 1) {
          throw new Error("temporary write failure");
        }
        disk[path] = text;
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });
      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: ["a", "b", "d"].map((name) => ({
          uri: `file:///repo/app/src/${name}.ts`, path: `/repo/app/src/${name}.ts`,
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "HELLO" }],
        })),
      });
      await waitFor(() => expect(disk["src/d.ts"]).toBe("HELLO delta"));
      expect(attempts).toEqual(new Map([["src/a.ts", 1], ["src/b.ts", 2], ["src/d.ts", 2]]));
      await waitFor(() => expect(storedRecoveryEntries().some(({ entry }) => entry.status === "committed")).toBe(true));
      await act(async () => { fireEvent.keyDown(window, { key: "z", ctrlKey: true }); });
      await workspaceTestHarness.confirmWorkspaceUndo();
      await waitFor(() => expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]));
      expect(disk["src/b.ts"]).toBe(PRE["src/b.ts"]);
      expect(disk["src/d.ts"]).toBe("hello delta");
    });

    it("creates recovery journal for plan-less text edits, captures partial failure effects, and restores via recovery entry", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("planless-partial", "src/c.ts");
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);

      // Make write to src/b.ts fail with disk error
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        if (path === "src/b.ts") {
          throw new Error("disk I/O error on b.ts");
        }
        disk[path] = text;
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: [
          {
            uri: "file:///repo/app/src/a.ts",
            path: "/repo/app/src/a.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }],
          },
          {
            uri: "file:///repo/app/src/b.ts",
            path: "/repo/app/src/b.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } }, newText: "BETA" }],
          },
        ],
      });

      // Verification:
      // a.ts was applied to disk, b.ts was not modified
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("recovery required"));
      expect(useAppStore.getState().statusMessage).toContain("Workspace edit postcondition failed");
      expect(useAppStore.getState().statusMessage).toContain("Applied changes on: /repo/app/src/a.ts");
      expect(disk["src/a.ts"]).toBe("hello ALPHA");
      expect(disk["src/b.ts"]).toBe("hello beta");

      // Undo must stay disabled (no success history registered for partial failure)
      expect(undoItem(registrationRef)?.enabled).toBe(false);

      // Journal entry must be in recovery-required state with applied effects
      const entries = storedRecoveryEntries();
      expect(entries).toHaveLength(1);
      const journalEntry = entries[0]!.entry;
      expect(journalEntry.status).toBe("recovery-required");
      expect(journalEntry.verification?.appliedEffects).toContain("/repo/app/src/a.ts");

      // Review and execute recovery via reviewRefactorRecovery action
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      const reviewPromise = registrationRef.current?.executeAction("workspace.reviewRefactorRecovery");
      const review = await screen.findByTestId("refactor-recovery-review");
      const restoreButton = within(review).getByTestId("refactor-recovery-restore");
      await waitFor(() => expect(restoreButton).toBeEnabled());
      fireEvent.click(restoreButton);
      await reviewPromise;

      // Recovery restored src/a.ts to preText and left src/b.ts untouched
      await waitFor(() => expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]));
      expect(disk["src/b.ts"]).toBe(PRE["src/b.ts"]);
      expect(getRefactorRecoveryJournalV2(journalEntry.recoveryId)?.status).toBe("rolled-back");
      expect(useAppStore.getState().statusMessage).toContain("recovery complete");

      // Idempotent re-run reports no pending entries
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.reviewRefactorRecovery");
      });
      expect(useAppStore.getState().statusMessage).toContain("No pending recovery entries found");
    });

    it("aborts with zero writes when the plan-less recovery journal cannot be persisted", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("planless-quota", "src/c.ts");
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
      const storage = installRecordingStorage((key) => {
        if (key.startsWith(RECOVERY_V2_PREFIX)) throw new Error("quota exceeded");
      });

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await emit("lsp://workspace-apply-edit", {
          requestId: "req-quota",
          workspaceId: workspace.workspaceInstanceId,
          edit: {
            documentEdits: [
              {
                uri: "file:///repo/app/src/a.ts",
                path: "/repo/app/src/a.ts",
                edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }],
              },
            ],
          },
          label: "Replace matches",
        });
      });

      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "Refactor recovery journal could not be persisted, no changes were applied",
      ));
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]);
      expect(undoItem(registrationRef)?.enabled).toBe(false);
      storage.restore();
    });

    it("refuses to overwrite conflicting third-party edits during plan-less recovery", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("planless-conflict", "src/c.ts");
      const preA = PRE["src/a.ts"]!;
      const postA = "hello ALPHA";
      recordRefactorRecoveryJournalV2({
        schemaVersion: 2,
        recoveryId: "rec-conflict-1",
        transactionId: "tx-conflict-1",
        actionId: "workspace-edit:replace-1",
        kind: "replace",
        workspaceRoot: "/repo/app",
        createdAt: 100,
        updatedAt: 200,
        status: "recovery-required",
        appliedOperationIndex: null,
        documents: [
          {
            uri: "file:///repo/app/src/a.ts",
            canonicalPath: "/repo/app/src/a.ts",
            preText: preA,
            preHash: sha256Hex(preA),
            postText: postA,
            postHash: sha256Hex(postA),
            encoding: "UTF-8",
            bom: false,
            eol: "lf",
          },
        ],
        resourceMoves: [],
        verification: { mismatchedUris: [], checkedAt: null },
      });

      // Third-party modifies src/a.ts to something else before recovery runs
      disk["src/a.ts"] = "third-party content";
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");

      // RC-02: auto-discover opens the review dialog with restore disabled.
      const review = await screen.findByTestId("refactor-recovery-review");
      expect(within(review).getByTestId("refactor-recovery-restore")).toBeDisabled();
      expect(review.textContent).toContain("a.ts");
      fireEvent.click(within(review).getByTestId("refactor-recovery-keep"));
      await waitFor(() => expect(screen.queryByTestId("refactor-recovery-review")).not.toBeInTheDocument());
      expect(disk["src/a.ts"]).toBe("third-party content");
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(getRefactorRecoveryJournalV2("rec-conflict-1")?.status).toBe("recovery-required");
    });

    it("queues editor undo until the cross-file post-state and journal are committed", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("pending-history", "src/a.ts");
      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/a.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      let releasePostRead!: () => void;
      const postRead = new Promise<void>((resolve) => { releasePostRead = resolve; });
      let waiting = false;
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (path === "src/b.ts" && disk[path] === "hello BETA") {
          waiting = true;
          await postRead;
        }
        return workspaceTestHarness.file(path, disk[path]!);
      });
      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: [
          { uri: "file:///repo/app/src/a.ts", path: "/repo/app/src/a.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }] },
          { uri: "file:///repo/app/src/b.ts", path: "/repo/app/src/b.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } }, newText: "BETA" }] },
        ],
      });
      try {
        await waitFor(() => expect(waiting).toBe(true));
        const pane = screen.getByTestId("code-workspace-editor-pane");
        fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
        // The document ledger must not restore only the open buffer while
        // the multi-file journal is still being verified.
        expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspace.workspaceInstanceId!)
          .openFiles["root:app:src/a.ts"]?.text).toBe("hello ALPHA");
      } finally {
        await act(async () => { releasePostRead(); });
      }
      await waitFor(() => expect(disk["src/b.ts"]).toBe(PRE["src/b.ts"]));
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspace.workspaceInstanceId!)
        .openFiles["root:app:src/a.ts"]?.text).toBe(PRE["src/a.ts"]);
    });

    it("commits recovery journal and supports single undo on verified success", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("planless-success", "src/c.ts");
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: [
          {
            uri: "file:///repo/app/src/a.ts",
            path: "/repo/app/src/a.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }],
          },
          {
            uri: "file:///repo/app/src/b.ts",
            path: "/repo/app/src/b.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } }, newText: "BETA" }],
          },
        ],
      });

      await waitFor(() => expect(disk["src/a.ts"]).toBe("hello ALPHA"));
      expect(disk["src/b.ts"]).toBe("hello BETA");

      // Pending recovery entry is not left behind
      const pending = storedRecoveryEntries().filter((e) => e.entry.status === "recovery-required");
      expect(pending).toHaveLength(0);

      // Execute undo via window keydown: both files restored to PRE
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await workspaceTestHarness.confirmWorkspaceUndo();
      await waitFor(() => expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]));
      expect(disk["src/b.ts"]).toBe(PRE["src/b.ts"]);

      // Redo: both files re-applied
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(disk["src/a.ts"]).toBe("hello ALPHA"));
      expect(disk["src/b.ts"]).toBe("hello BETA");
    });
  });
}
