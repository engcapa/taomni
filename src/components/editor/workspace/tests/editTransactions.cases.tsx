import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import * as workspaceSearchModule from "../../../../lib/editor/workspaceSearch";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "./workspaceEdits.cases";

export function registerEditTransactionsCases(workspaceTestHarness: registerWorkspaceEditsCasesFixture) {
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
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" }));
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
        path: "/repo/app/src/Service.java",
        uri: "file:///repo/app/src/Service.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true, codeActionKinds: [kind] }),
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
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [action],
      });
      workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
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

    function storedJournals(): Array<{ key: string; entry: { status: string } }> {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(RECOVERY_V2_PREFIX))
        .map((key) => ({ key, entry: JSON.parse(window.localStorage.getItem(key)!) }));
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

    async function runWorkflow(
      registrationRef: { current: WorkspaceCommandRegistration | null },
      commandId: string,
    ): Promise<void> {
      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
    }

    it("registers exactly one success history entry whose single undo/redo spans the transaction", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-normal"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
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
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
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
        workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-quota"), { onCommandsChange });
        await screen.findByTitle("app / src/Service.java");
        await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

        await runWorkflow(registrationRef, "workspace.rearrangeCode");
        await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
          "Refactor recovery journal could not be persisted",
        ));
        expect(useAppStore.getState().statusMessage).toContain("quota exceeded");
        expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
        expect(fileText("instance-improve002-quota")).toBe(SERVICE_PRE);
        expect(storedJournals()).toHaveLength(0);
        expect(storage.keys().filter((key) => key.startsWith(RECOVERY_V2_PREFIX))).toHaveLength(0);
      } finally {
        storage.restore();
      }
    });

    it("keeps a postcondition mismatch out of success history and leaves a pending journal", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      const concurrentText = `${SERVICE_POST}// third-party typing during save\n`;
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
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
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-mismatch"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
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
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => opts.title === "Rearrange preview");
      // The disk write reports a proven zero disk effect (e.g. a readonly or
      // rejected save) after the buffer has already taken the applied text.
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("cannot replace readonly file"),
        { kind: "io", effect: "none" },
      ));

      workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-main001-buffer-effect"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
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
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
    });

    it("treats an unreadable post-state as recovery-required without success history", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
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
        workspaceTestHarness.workspaceMocks.workspaceListDir.mockRejectedValue(new Error("post-state listing failed"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-unreadable"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
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
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(
        workspaceTestHarness.file("src/Service.java", "foreign bytes on disk\n", { hash: "foreign-disk-hash" }),
      );
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("atomic replace acknowledgement was lost"),
        {
          kind: "io",
          effect: "unknown",
          intentHash: "intended-rearranged-hash",
          intentByteLength: SERVICE_POST.length,
          oldHash: "hash-pre",
        },
      ));

      workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-unknown"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
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
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.cleanup");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      workspaceTestHarness.renderWorkspace(workflowWorkspace("instance-improve002-cleanup"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
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
describe("ED-IMPROVE-003 provider payload boundary (mounted)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const TARGET_URI = "file:///repo/app/src/Service.java";
    const TARGET_PATH = "/repo/app/src/Service.java";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };

    function boundaryWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-improve003",
        workspaceInstanceId: instance,
        name: "Improve 003",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles["root:app:src/Service.java"]?.text;
    }

    const ACTION = {
      title: "Rearrange members",
      kind: "source.rearrange",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { title: "Rearrange members" },
    };

    async function runBoundary(
      instance: string,
      commandId: string,
      resolvedAction: Record<string, unknown> | null,
      advertisedKinds: string[] = ["source.rearrange"],
    ): Promise<void> {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" }));
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
        path: TARGET_PATH,
        uri: TARGET_URI,
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true, codeActionKinds: advertisedKinds }),
      }));
      const resolvedKind = resolvedAction && typeof resolvedAction.kind === "string"
        ? resolvedAction.kind
        : ACTION.kind;
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [{ ...ACTION, kind: resolvedKind }],
      });
      workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        action: resolvedAction,
      });
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      workspaceTestHarness.renderWorkspace(boundaryWorkspace(instance), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
    }

    function expectRejected(instance: string, reason: string): void {
      expect(useAppStore.getState().statusMessage).toContain(reason);
      expect(useAppStore.getState().statusMessage).toContain("nothing applied");
      expect(fileText(instance)).toBe(SERVICE_PRE);
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    }

    it("rejects a cross-file payload without filtering it", async () => {
      await runBoundary("instance-improve003-cross-file", "workspace.rearrangeCode", {
        ...ACTION,
        edit: {
          documentEdits: [
            { uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] },
            { uri: "file:///repo/app/src/Other.java", path: "/repo/app/src/Other.java", edits: [SWAP_EDIT] },
          ],
        },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "/repo/app/src/Other.java",
      ));
      expectRejected("instance-improve003-cross-file", "different or contradictory document");
    });

    it("rejects a rename resource operation even beside a text edit", async () => {
      await runBoundary("instance-improve003-resource", "workspace.rearrangeCode", {
        ...ACTION,
        edit: {
          documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }],
          operations: [{ kind: "rename", oldUri: TARGET_URI, newUri: "file:///repo/app/src/Renamed.java" }],
        },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "resource operations (rename)",
      ));
      expectRejected("instance-improve003-resource", "resource operations (rename)");
    });

    it("rejects an edit+command payload", async () => {
      await runBoundary("instance-improve003-mixed", "workspace.rearrangeCode", {
        ...ACTION,
        edit: { documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }] },
        command: "editor.action.extraSideEffect",
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "both an edit and the command",
      ));
      expectRejected("instance-improve003-mixed", "both an edit and the command");
    });

    it("rejects a provider-disabled action", async () => {
      await runBoundary("instance-improve003-disabled", "workspace.rearrangeCode", {
        ...ACTION,
        edit: { documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }] },
        raw: { title: "Rearrange members", disabled: true },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("disabled"));
      expectRejected("instance-improve003-disabled", "disabled");
    });

    it("rejects a malformed or reversed edit range", async () => {
      await runBoundary("instance-improve003-range", "workspace.rearrangeCode", {
        ...ACTION,
        edit: {
          documentEdits: [{
            uri: TARGET_URI,
            path: TARGET_PATH,
            edits: [{
              range: { start: { line: 4, character: 5 }, end: { line: 3, character: 0 } },
              newText: "x",
            }],
          }],
        },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "malformed or reversed",
      ));
      expectRejected("instance-improve003-range", "malformed or reversed");
    });

    it("rejects a null resolve as malformed", async () => {
      await runBoundary("instance-improve003-null", "workspace.rearrangeCode", null);
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "resolve returned no action",
      ));
      expect(fileText("instance-improve003-null")).toBe(SERVICE_PRE);
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });

    it("does not relabel source.fixAll as an equivalent cleanup", async () => {
      await runBoundary(
        "instance-improve003-fixall",
        "workspace.codeCleanup",
        {
          title: "Fix all",
          kind: "source.fixAll",
          isPreferred: true,
          edit: { documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }] },
          command: null,
          commandArguments: null,
          raw: { title: "Fix all" },
        },
        ["source.fixAll"],
      );
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "Provider returned no cleanup action",
      ));
      expect(fileText("instance-improve003-fixall")).toBe(SERVICE_PRE);
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    });
  });
describe("ED-REPAIR-002: replace preflight and open buffer freeze conditions (mounted)", () => {
    function setupWorkspace(instanceId: string, openFile: string) {
      const disk: Record<string, string> = {};
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
        return workspaceTestHarness.file(path, disk[path]!, { hash: `hash-${disk[path]!}` });
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

    it.each(["disk-before", "open-during-final-read", "open-during-history-read", "excluded"])("validates exactly the selected replace set before the first effect: %s (ED-REPAIR-002-A1)", async (scenario) => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("repair-002-b-modified", "src/c.ts");
      disk["src/c.ts"] = "hello reader";
      disk["src/a.ts"] = "hello needle";
      disk["src/b.ts"] = "hello needle";

      let searchHandler: ((event: workspaceSearchModule.WorkspaceSearchEvent) => void) | null = null;
      const unlisten = vi.fn();
      vi.spyOn(workspaceSearchModule, "subscribeWorkspaceSearch").mockImplementation(async (_id, handler) => {
        searchHandler = handler;
        return unlisten;
      });
      vi.spyOn(workspaceSearchModule, "workspaceSearchStart").mockResolvedValue("search-repair-002");

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");

      // Open find in files panel
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.findInFiles");
      });

      const searchInput = await screen.findByLabelText("Search query");
      fireEvent.change(searchInput, { target: { value: "needle" } });
      fireEvent.keyDown(searchInput, { key: "Enter" });

      await waitFor(() => expect(searchHandler).not.toBeNull());

      // Emit search matches for a.ts and b.ts
      await act(async () => {
        searchHandler?.({
          searchId: "search-repair-002",
          kind: "batch",
          matches: [
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/a.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/b.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
          ],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
        searchHandler?.({
          searchId: "search-repair-002",
          kind: "done",
          matches: [],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
      });

      // Enter replace text and preview
      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "REPLACED" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));

      const preview = await screen.findByTestId("code-workspace-replace-preview");
      expect(preview).toBeInTheDocument();

      if (scenario.startsWith("open-during")) {
        let readsOfB = 0;
        let readsOfA = 0;
        workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
          // Commit reads B for outer validation, recovery snapshot, then final preflight.
          // A is read again by the applier (4) and the local-history committer (5).
          if (path === "src/b.ts") readsOfB += 1;
          if (path === "src/a.ts") readsOfA += 1;
          if ((scenario === "open-during-final-read" && path === "src/b.ts" && readsOfB === 3)
            || (scenario === "open-during-history-read" && path === "src/a.ts" && readsOfA === 5)) {
            useCodeWorkspaceStore.getState().updateOpenFiles(workspace.workspaceInstanceId!, (current) => ({
              ...current,
              "root:app:src/b.ts": { ...current["root:app:src/c.ts"]!, key: "root:app:src/b.ts", path: "src/b.ts",
                ref: { kind: "root", rootId: "app", path: "src/b.ts" },
                text: "hello user typing", savedText: "hello needle", dirty: true, documentRevision: 1 },
            }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return workspaceTestHarness.file(path, disk[path]!, { hash: `hash-${disk[path]!}` });
        });
      } else {
        if (scenario === "excluded") {
          fireEvent.click(within(preview).getByLabelText("Include all matches in /repo/app/src/b.ts"));
        }
        disk["src/b.ts"] = "hello modified";
      }

      // Click Replace All
      fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

      if (scenario === "excluded") {
        await waitFor(() => expect(disk["src/a.ts"]).toBe("hello REPLACED"));
        expect(disk["src/b.ts"]).toBe("hello modified");
        await waitFor(() => expect(registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled).toBe(true));
        await act(async () => { await registrationRef.current?.executeAction("workspace.undoWorkspaceEdit"); });
        fireEvent.click(await screen.findByTestId("code-workspace-undo-confirm-ok"));
        await waitFor(() => expect(disk["src/a.ts"]).toBe("hello needle"));
        expect(disk["src/b.ts"]).toBe("hello modified");
        return;
      }

      // Preflight detects disk hash mismatch on src/b.ts and refuses with zero writes
      await waitFor(() => {
        const status = useAppStore.getState().statusMessage;
        expect(status).toMatch(scenario === "disk-before" ? /changed on disk since/ : /opened since replace preview|unsaved modifications/);
      });

      // Both files must have ZERO writes applied
      expect(disk["src/a.ts"]).toBe("hello needle");
      expect(disk["src/b.ts"]).toBe(scenario === "disk-before" ? "hello modified" : "hello needle");
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });

    it("preserves file A effect when file B write fails after first write (ED-REPAIR-002-A2)", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("repair-002-b-fail", "src/c.ts");
      disk["src/c.ts"] = "hello reader";
      disk["src/a.ts"] = "hello needle";
      disk["src/b.ts"] = "hello needle";

      let searchHandler: ((event: workspaceSearchModule.WorkspaceSearchEvent) => void) | null = null;
      const unlisten = vi.fn();
      vi.spyOn(workspaceSearchModule, "subscribeWorkspaceSearch").mockImplementation(async (_id, handler) => {
        searchHandler = handler;
        return unlisten;
      });
      vi.spyOn(workspaceSearchModule, "workspaceSearchStart").mockResolvedValue("search-repair-002-post");

      // Inject write failure on src/b.ts
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

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.findInFiles");
      });

      const searchInput = await screen.findByLabelText("Search query");
      fireEvent.change(searchInput, { target: { value: "needle" } });
      fireEvent.keyDown(searchInput, { key: "Enter" });

      await waitFor(() => expect(searchHandler).not.toBeNull());

      await act(async () => {
        searchHandler?.({
          searchId: "search-repair-002-post",
          kind: "batch",
          matches: [
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/a.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/b.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
          ],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
        searchHandler?.({
          searchId: "search-repair-002-post",
          kind: "done",
          matches: [],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
      });

      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "REPLACED" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));

      const preview = await screen.findByTestId("code-workspace-replace-preview");
      expect(preview).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

      // Operation A succeeded and its effect is preserved on disk!
      await waitFor(() => expect(disk["src/a.ts"]).toBe("hello REPLACED"));
      // Operation B failed and was not modified
      expect(disk["src/b.ts"]).toBe("hello needle");

      // Status message indicates failure / recovery required
      await waitFor(() => {
        const status = useAppStore.getState().statusMessage;
        expect(status).toContain("recovery required");
      });
    });
  });
}
