import { findEditorByTitle } from "../../editorReadiness";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../../../lib/appDialogs";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "../../workspaceEdits.cases";

export interface registereditTransactionsHistory1CasesContext {
  workspaceTestHarness: registerWorkspaceEditsCasesFixture;
}

export function registereditTransactionsHistory1Cases(caseContext: registereditTransactionsHistory1CasesContext) {
  describe("ED-IMPROVE-002 workflow postcondition/history/recovery (mounted)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };
    const RECOVERY_V2_PREFIX = "taomni.refactor.recovery.v2:";
    const OPEN_KEY = "root:app:src/Service.java";

    function workflowWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-improve002",
        workspaceInstanceId: instance,
        name: "Improve 002",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles[OPEN_KEY]?.text;
    }

    function mockWorkflowProvider(kind: "source.rearrange" | "source.cleanup") {
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" }));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
        path: "/repo/app/src/Service.java",
        uri: "file:///repo/app/src/Service.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ codeAction: true, codeActionKinds: [kind] }),
      }));
      const action = {
        title: kind === "source.rearrange" ? "Rearrange members" : "Clean up",
        kind,
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: kind },
      };
      caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [action],
      });
      caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
        action: {
          ...action,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [SWAP_EDIT],
            }],
          },
        },
      });
    }

    function storedJournals(): Array<{ key: string; entry: { status: string; }; }> {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(RECOVERY_V2_PREFIX))
        .map((key) => ({ key, entry: JSON.parse(window.localStorage.getItem(key)!) }));
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

    async function runWorkflow(
      registrationRef: { current: WorkspaceCommandRegistration | null; },
      commandId: string,
    ): Promise<void> {
      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
    }

    it("registers exactly one success history entry whose single undo/redo spans the transaction", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      caseContext.workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-normal"), { onCommandsChange });
      await findEditorByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      await waitFor(() => expect(fileText("instance-improve002-normal")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Rearranged"));
      // The committed journal is closed, not left pending.
      expect(storedJournals().filter((entry) => entry.entry.status === "committed")).toHaveLength(1);

      // The shared editor undo claims the journal entry: one Ctrl+Z restores
      // the whole transaction, a second one is a no-op (exactly one entry).
      const pane = screen.getByTestId("code-workspace-editor-pane");
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Undid Rearrange Code"));
      expect(fileText("instance-improve002-normal")).toBe(SERVICE_PRE);
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-improve002-normal")
        .openFiles[OPEN_KEY]?.historyReplay).toBe(true);
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(fileText("instance-improve002-normal")).toBe(SERVICE_PRE);

      // The journal entry stays redoable at the history-owner level; the
      // native AUDIT-015 redo stroke exercises the surface route.
    });

    it("aborts with zero writes when the workflow recovery journal cannot be persisted", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      const storage = installRecordingStorage((key) => {
        if (key.startsWith(RECOVERY_V2_PREFIX)) throw new Error("quota exceeded");
      });
      try {
        caseContext.workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-quota"), { onCommandsChange });
        await findEditorByTitle("app / src/Service.java");
        await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

        await runWorkflow(registrationRef, "workspace.rearrangeCode");
        await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
          "Refactor recovery journal could not be persisted",
        ));
        expect(useAppStore.getState().statusMessage).toContain("quota exceeded");
        expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
        expect(fileText("instance-improve002-quota")).toBe(SERVICE_PRE);
        expect(storedJournals()).toHaveLength(0);
        expect(storage.keys().filter((key) => key.startsWith(RECOVERY_V2_PREFIX))).toHaveLength(0);
      } finally {
        storage.restore();
      }
    });

    it("keeps a postcondition mismatch out of success history and leaves a pending journal", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      const concurrentText = `${SERVICE_POST}// third-party typing during save\n`;
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => {
        // A concurrent writer replaces the buffer while the save is in
        // flight, so the writeback is a stale snapshot: disk gets the applied
        // text, the live buffer keeps the newer third-party text. The
        // canonical postcondition must detect the mismatch and refuse a
        // success history entry.
        useCodeWorkspaceStore.getState().updateOpenFiles(
          "instance-improve002-mismatch",
          (current) => {
            const target = current[OPEN_KEY];
            if (!target) return current;
            return {
              ...current,
              [OPEN_KEY]: {
                ...target,
                text: concurrentText,
                dirty: true,
                documentRevision: (target.documentRevision ?? 0) + 2,
              },
            };
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        return caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      caseContext.workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-mismatch"), { onCommandsChange });
      await findEditorByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "postcondition could not be verified",
      ));
      expect(fileText("instance-improve002-mismatch")).toBe(concurrentText);
      expect(useAppStore.getState().statusMessage).not.toContain("Rearranged Service.java");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    // ED-MAIN-001: a clean-buffer workflow edit mutates the buffer before the
    // awaited save. When that save fails, the mounted transaction must report
    // the already-performed buffer effect, keep the journal discoverable for
    // recovery, and never register a normal success history entry.
    it("reports the performed buffer effect and recovery-required when the workflow save fails (ED-MAIN-001)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => opts.title === "Rearrange preview");
      // The disk write reports a proven zero disk effect (e.g. a readonly or
      // rejected save) after the buffer has already taken the applied text.
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("cannot replace readonly file"),
        { kind: "io", effect: "none" },
      ));

      caseContext.workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-main001-buffer-effect"), { onCommandsChange });
      await findEditorByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // The applied text is present in the buffer even though the save failed.
      await waitFor(() => expect(fileText("instance-main001-buffer-effect")).toBe(SERVICE_POST));
      const message = useAppStore.getState().statusMessage;
      expect(message).toContain("postcondition could not be verified");
      expect(message).not.toContain("Rearranged Service.java");
      // The prepared journal is not closed as a committed no-op.
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
    });

    it("treats an unreadable post-state as recovery-required without success history", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => {
        // The buffer closes while the save is in flight; the post-state read
        // then falls back to disk, which this fault makes unreadable.
        useCodeWorkspaceStore.getState().updateOpenFiles(
          "instance-improve002-unreadable",
          (current) => {
            const next = { ...current };
            delete next[OPEN_KEY];
            return next;
          },
        );
        caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockRejectedValue(new Error("post-state listing failed"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        return caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      caseContext.workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-unreadable"), { onCommandsChange });
      await findEditorByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "postcondition could not be verified",
      ));
      expect(useAppStore.getState().statusMessage).not.toContain("Rearranged Service.java");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    it("surfaces an unknown write acknowledgement without success history", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(
        caseContext.workspaceTestHarness.file("src/Service.java", "foreign bytes on disk\n", { hash: "foreign-disk-hash" }),
      );
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("atomic replace acknowledgement was lost"),
        {
          kind: "io",
          effect: "unknown",
          intentHash: "intended-rearranged-hash",
          intentByteLength: SERVICE_POST.length,
          oldHash: "hash-pre",
        },
      ));

      caseContext.workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-unknown"), { onCommandsChange });
      await findEditorByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      await waitFor(() => expect(useAppStore.getState().statusMessage).toMatch(
        /write result is unknown/i,
      ));
      expect(useAppStore.getState().statusMessage).not.toContain("Rearranged Service.java");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    it("cleanup shares the single-history journal contract", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.cleanup");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      caseContext.workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-cleanup"), { onCommandsChange });
      await findEditorByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.codeCleanup");
      await waitFor(() => expect(fileText("instance-improve002-cleanup")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Cleaned up"));

      const pane = screen.getByTestId("code-workspace-editor-pane");
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Undid Code Cleanup"));
      expect(fileText("instance-improve002-cleanup")).toBe(SERVICE_PRE);
    });
  });
}
