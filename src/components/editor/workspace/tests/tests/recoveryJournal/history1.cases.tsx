import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../../../lib/appDialogs";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { sha256Hex } from "../../../projectAnalysisModel";
import { getRefactorRecoveryJournalV2, recordRefactorRecoveryJournalV2 } from "../../../refactorPlan";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "../../workspaceEdits.cases";

export interface registerrecoveryJournalHistory1CasesContext {
  workspaceTestHarness: registerWorkspaceEditsCasesFixture;
}

export function registerrecoveryJournalHistory1Cases(caseContext: registerrecoveryJournalHistory1CasesContext) {
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
      registrationRef: { current: WorkspaceCommandRegistration | null; };
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
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => caseContext.workspaceTestHarness.entry(rel.split("/").pop()!, rel))
          : [caseContext.workspaceTestHarness.entry("src", "src", "dir")]
      ));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return caseContext.workspaceTestHarness.file(path, disk[path]!);
      });
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
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
    ): { restore: () => void; keys: () => string[]; } {
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
      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockRejectedValue(new Error("listing unavailable"));
      await act(async () => {
        await emit("lsp://workspace-apply-edit", {
          requestId: "missing-snapshots", workspaceId: workspace.workspaceInstanceId,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/a.ts", path: "/repo/app/src/a.ts",
              edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }]
            }]
          },
        });
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toMatch(/preimage|snapshot/i));
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]);
    });

    it("retries successive failure boundaries against the full confirmed plan and undoes all files", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("successive-retries", "src/c.ts");
      disk["src/d.ts"] = "hello delta";
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
      const attempts = new Map<string, number>();
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (_root: string, path: string, text: string) => {
        const attempt = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, attempt);
        if ((path === "src/b.ts" || path === "src/d.ts") && attempt === 1) {
          throw new Error("temporary write failure");
        }
        disk[path] = text;
        return caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });
      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
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
      await caseContext.workspaceTestHarness.confirmWorkspaceUndo();
      await waitFor(() => expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]));
      expect(disk["src/b.ts"]).toBe(PRE["src/b.ts"]);
      expect(disk["src/d.ts"]).toBe("hello delta");
    });

    it("creates recovery journal for plan-less text edits, captures partial failure effects, and restores via recovery entry", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("planless-partial", "src/c.ts");
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);

      // Make write to src/b.ts fail with disk error
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        if (path === "src/b.ts") {
          throw new Error("disk I/O error on b.ts");
        }
        disk[path] = text;
        return caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
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

      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
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
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
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

      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");

      // RC-02: auto-discover opens the review dialog with restore disabled.
      const review = await screen.findByTestId("refactor-recovery-review");
      expect(within(review).getByTestId("refactor-recovery-restore")).toBeDisabled();
      expect(review.textContent).toContain("a.ts");
      fireEvent.click(within(review).getByTestId("refactor-recovery-keep"));
      await waitFor(() => expect(screen.queryByTestId("refactor-recovery-review")).not.toBeInTheDocument());
      expect(disk["src/a.ts"]).toBe("third-party content");
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(getRefactorRecoveryJournalV2("rec-conflict-1")?.status).toBe("recovery-required");
    });

    it("queues editor undo until the cross-file post-state and journal are committed", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("pending-history", "src/a.ts");
      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/a.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      let releasePostRead!: () => void;
      const postRead = new Promise<void>((resolve) => { releasePostRead = resolve; });
      let waiting = false;
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (path === "src/b.ts" && disk[path] === "hello BETA") {
          waiting = true;
          await postRead;
        }
        return caseContext.workspaceTestHarness.file(path, disk[path]!);
      });
      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: [
          {
            uri: "file:///repo/app/src/a.ts", path: "/repo/app/src/a.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }]
          },
          {
            uri: "file:///repo/app/src/b.ts", path: "/repo/app/src/b.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } }, newText: "BETA" }]
          },
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

      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
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
      await caseContext.workspaceTestHarness.confirmWorkspaceUndo();
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
