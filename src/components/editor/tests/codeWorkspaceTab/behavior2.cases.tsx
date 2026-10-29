import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import mermaid from "mermaid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmAppDialog, promptAppDialog } from "../../../../lib/appDialogs";
import type { LspDocumentStatus } from "../../../../lib/editor/lsp";
import type { StructuredTestResults } from "../../../../lib/editor/workspace";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import { globalEditorConfigResolver } from "../../workspace/editorConfigResolver";
import { registerFilesCases } from "../../workspace/tests/files.cases";
import { registerInteractionCases } from "../../workspace/tests/interaction.cases";
import { registerLanguageCases } from "../../workspace/tests/language.cases";
import { registerLayoutCases } from "../../workspace/tests/layout.cases";
import { registerSaveCases } from "../../workspace/tests/save.cases";
import { registerWorkspaceEditsCases } from "../../workspace/tests/workspaceEdits.cases";
import { clearGitSnapshotCache, clearGitSnapshotInFlight } from "../../workspace/useWorkspaceGitSnapshots";
import { workspaceActionRegistry } from "../../workspace/workspaceActionRegistry";
import {
  clipboardMocks,
  confirmWorkspaceUndo,
  csharpStatus,
  dapMocks,
  defaultCapabilities,
  descriptorDiscoveryMock,
  documentStatus,
  entry,
  file,
  gitMocks,
  ipcMocks,
  localHistoryMocks,
  lspMocks,
  projectFactsMock,
  renderWorkspace,
  runtimeState,
  saveCommitObservations,
  saveRaceGate,
  settingsNavigationMocks,
  toolbarControl,
  workspaceMocks,
  writeAck,
} from "./harness";

export function registerCodeWorkspaceTabBehavior2Cases() {

  describe("CodeWorkspaceTab", () => {
    beforeEach(() => {
      // Compare cases override clipboard reads. Restore both the implementations
      // and contents so clipboard workflows do not depend on registration order.
      clipboardMocks.reset();
      window.localStorage.clear();
      workspaceActionRegistry.clear();
      globalEditorConfigResolver.clearAll();
      clearGitSnapshotCache();
      clearGitSnapshotInFlight();
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
      vi.mocked(promptAppDialog).mockReset().mockResolvedValue(null);
      useAppStore.setState({
        statusMessage: "Ready",
        codeWorkspaceByTab: {},
      });
      useCodeWorkspaceStore.setState({ byInstanceId: {} });
      saveCommitObservations.results.length = 0;
      projectFactsMock.state.status = "idle";
      projectFactsMock.state.reason = null;
      projectFactsMock.state.generation = 0;
      projectFactsMock.state.isStale = false;
      projectFactsMock.refresh.mockReset().mockResolvedValue(undefined);
      projectFactsMock.useProjectFacts.mockClear();
      descriptorDiscoveryMock.state.status = "idle";
      descriptorDiscoveryMock.state.discovery = null;
      descriptorDiscoveryMock.state.reason = null;
      descriptorDiscoveryMock.refresh.mockReset().mockResolvedValue(undefined);
      descriptorDiscoveryMock.useProjectDescriptorDiscovery.mockClear();
      localHistoryMocks.historySnapshot.mockReset().mockResolvedValue(null);
      localHistoryMocks.historyList.mockReset().mockResolvedValue([]);
      localHistoryMocks.historyRead.mockReset().mockResolvedValue("");
      localHistoryMocks.formatLocalHistoryTime.mockReset().mockReturnValue("just now");
      workspaceMocks.workspaceListDir.mockReset();
      workspaceMocks.workspaceCompactChain.mockReset();
      workspaceMocks.workspaceListFilesRecursive.mockReset();
      workspaceMocks.workspaceDetectGitRoots.mockReset();
      workspaceMocks.workspaceDetectTasks.mockReset();
      workspaceMocks.workspaceJavaRunTargets.mockReset().mockResolvedValue([]);
      workspaceMocks.workspaceExecutionModel.mockReset().mockResolvedValue({
        projects: [],
        buildTargets: [],
        runConfigurations: [],
        debugConfigurations: [],
        tools: [],
      });
      workspaceMocks.workspaceJavaRunTarget.mockReset().mockRejectedValue(new Error("No runnable Java main class"));
      workspaceMocks.workspaceTaskTree.mockReset().mockResolvedValue([]);
      workspaceMocks.workspaceTestResults.mockReset().mockResolvedValue({
        schema: "taomni.codeWorkspace.testResults",
        version: 1,
        source: "junit-xml",
        generatedAt: 1,
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 0 },
        diagnostics: [],
      } satisfies StructuredTestResults);
      workspaceMocks.workspaceDependencyTree.mockReset().mockResolvedValue([]);
      workspaceMocks.workspaceReadFile.mockReset();
      workspaceMocks.workspaceReadLooseFile.mockReset();
      workspaceMocks.workspaceReadFileWithEncoding.mockReset();
      workspaceMocks.workspaceReadLooseFileWithEncoding.mockReset();
      workspaceMocks.workspaceWriteFile.mockReset();
      workspaceMocks.workspaceWriteLooseFile.mockReset();
      workspaceMocks.workspaceWriteFileEncoded.mockReset();
      workspaceMocks.workspaceWriteLooseFileEncoded.mockReset();
      workspaceMocks.workspaceCreateFile.mockReset();
      workspaceMocks.workspaceCreateDir.mockReset();
      workspaceMocks.workspaceDeletePath.mockReset();
      workspaceMocks.workspaceRenamePath.mockReset();
      workspaceMocks.workspaceApplyResourceOperation.mockReset();
      lspMocks.lspDetectServers.mockReset();
      lspMocks.lspSetJavaHome.mockReset().mockResolvedValue(undefined);
      lspMocks.lspSetJavaVmargs.mockReset().mockResolvedValue("-Xms1024m -Xmx1024m");
      lspMocks.lspSetJavaSettings.mockReset().mockResolvedValue(0);
      lspMocks.lspSetJavaBundles.mockReset().mockResolvedValue(undefined);
      lspMocks.lspOpenDocument.mockReset();
      lspMocks.lspChangeDocument.mockReset();
      lspMocks.lspSaveDocument.mockReset();
      lspMocks.lspCloseDocument.mockReset();
      lspMocks.lspStopWorkspace.mockReset().mockResolvedValue(0);
      lspMocks.lspGetDiagnostics.mockReset();
      lspMocks.lspWorkspaceDiagnostics.mockReset().mockResolvedValue([]);
      lspMocks.lspBuildWorkspace.mockReset().mockResolvedValue("succeed");
      runtimeState.tauri = false;
      dapMocks.dapStartSession.mockReset();
      dapMocks.dapSendRequest.mockReset().mockResolvedValue({});
      dapMocks.dapSend.mockReset().mockResolvedValue(undefined);
      dapMocks.dapTerminate.mockReset().mockResolvedValue(undefined);
      dapMocks.listenDapEvents.mockReset().mockResolvedValue(() => { });
      dapMocks.dapResolveJavaMainClasses.mockReset();
      lspMocks.lspHover.mockReset();
      lspMocks.lspDefinition.mockReset();
      lspMocks.lspDeclaration.mockReset();
      lspMocks.lspTypeDefinition.mockReset();
      lspMocks.lspImplementation.mockReset();
      lspMocks.lspPrepareRename.mockReset();
      lspMocks.lspRename.mockReset();
      lspMocks.lspReadUriContents.mockReset();
      lspMocks.lspDownloadSources.mockReset();
      lspMocks.lspReferences.mockReset();
      lspMocks.lspPrepareCallHierarchy.mockReset();
      lspMocks.lspCallHierarchyIncoming.mockReset();
      lspMocks.lspCallHierarchyOutgoing.mockReset();
      lspMocks.lspPrepareTypeHierarchy.mockReset();
      lspMocks.lspTypeHierarchySupertypes.mockReset();
      lspMocks.lspTypeHierarchySubtypes.mockReset();
      lspMocks.lspDocumentSymbols.mockReset();
      lspMocks.lspDocumentHighlights.mockReset();
      lspMocks.lspInlayHints.mockReset();
      lspMocks.lspSemanticTokens.mockReset();
      lspMocks.lspSelectionRanges.mockReset();
      lspMocks.lspExecuteCommand.mockReset().mockResolvedValue(null);
      lspMocks.lspResolveWorkspaceEdit.mockReset().mockResolvedValue(undefined);
      lspMocks.lspResolveShowMessageRequest.mockReset().mockResolvedValue(undefined);
      lspMocks.lspCancelWorkDoneProgress.mockReset().mockResolvedValue(false);
      lspMocks.lspWorkspaceDidChangeWatchedFiles.mockReset().mockResolvedValue(0);
      lspMocks.lspStartWorkspaceWatcher.mockReset().mockResolvedValue(undefined);
      lspMocks.lspStopWorkspaceWatcher.mockReset().mockResolvedValue(undefined);
      lspMocks.lspWorkspaceDidFileOperation.mockReset().mockResolvedValue(1);
      lspMocks.lspWorkspaceWillFileOperation.mockReset().mockResolvedValue(1);
      lspMocks.lspDocumentSymbols.mockResolvedValue({ status: documentStatus(), symbols: [] });
      lspMocks.lspDocumentHighlights.mockResolvedValue({ status: documentStatus(), highlights: [] });
      lspMocks.lspInlayHints.mockResolvedValue({ status: documentStatus(), hints: [] });
      lspMocks.lspSemanticTokens.mockResolvedValue({ status: documentStatus(), tokens: [] });
      lspMocks.lspSelectionRanges.mockResolvedValue({ status: documentStatus(), ranges: [] });
      lspMocks.lspCompletion.mockReset();
      lspMocks.lspCompletion.mockResolvedValue({ status: documentStatus(), isIncomplete: false, items: [] });
      lspMocks.lspCompletionResolve.mockReset();
      lspMocks.lspCompletionResolve.mockResolvedValue(null);
      lspMocks.lspSignatureHelp.mockReset();
      lspMocks.lspSignatureHelp.mockResolvedValue({
        status: documentStatus(),
        signatures: [],
        activeSignature: 0,
        activeParameter: 0,
      });
      lspMocks.lspFormatting.mockReset();
      lspMocks.lspFormatting.mockResolvedValue({ status: documentStatus(), edits: [] });
      lspMocks.lspRangeFormatting.mockReset();
      lspMocks.lspRangeFormatting.mockResolvedValue({ status: documentStatus(), edits: [] });
      lspMocks.lspCodeActions.mockReset();
      lspMocks.lspCodeActions.mockResolvedValue({ status: documentStatus(), actions: [] });
      lspMocks.lspCodeActionResolve.mockReset();
      lspMocks.lspCodeActionResolve.mockImplementation(async (_descriptor: unknown, raw: unknown) => ({
        status: documentStatus({ available: true, active: true }),
        action: raw,
      }));
      lspMocks.lspWorkspaceSymbols.mockReset();
      lspMocks.lspWorkspaceSymbols.mockResolvedValue({
        status: documentStatus(),
        symbols: [],
        sessionCount: 0,
        providerCount: 0,
        skippedProviderCount: 0,
        failedProviderCount: 0,
        complete: false,
        truncated: false,
        diagnostics: [],
      });
      lspMocks.lspWorkspaceSymbolResolve.mockReset();
      lspMocks.lspPrepareCallHierarchy.mockResolvedValue({ status: documentStatus(), items: [] });
      lspMocks.lspCallHierarchyIncoming.mockResolvedValue({ status: documentStatus(), entries: [] });
      lspMocks.lspCallHierarchyOutgoing.mockResolvedValue({ status: documentStatus(), entries: [] });
      lspMocks.lspPrepareTypeHierarchy.mockResolvedValue({ status: documentStatus(), items: [] });
      lspMocks.lspTypeHierarchySupertypes.mockResolvedValue({ status: documentStatus(), items: [] });
      lspMocks.lspTypeHierarchySubtypes.mockResolvedValue({ status: documentStatus(), items: [] });
      ipcMocks.selectFilePath.mockReset();
      ipcMocks.selectFolderPath.mockReset();
      gitMocks.gitSnapshot.mockReset();
      gitMocks.gitIgnorePath.mockReset();
      gitMocks.gitBlobPair.mockReset();
      gitMocks.gitBlameLines.mockReset();
      gitMocks.gitChangeLabel.mockClear();
      vi.mocked(mermaid.initialize).mockClear();
      vi.mocked(mermaid.render).mockClear();
      lspMocks.lspDetectServers.mockResolvedValue([]);
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus());
      lspMocks.lspChangeDocument.mockResolvedValue(documentStatus({ active: true, available: true }));
      lspMocks.lspSaveDocument.mockResolvedValue(documentStatus({ active: true, available: true }));
      lspMocks.lspCloseDocument.mockResolvedValue(documentStatus());
      lspMocks.lspPrepareRename.mockResolvedValue({
        status: documentStatus(),
        allowed: false,
        range: null,
        placeholder: null,
        message: null,
      });
      lspMocks.lspRename.mockResolvedValue({
        status: documentStatus(),
        edit: { documentEdits: [], operations: [] },
      });
      lspMocks.lspGetDiagnostics.mockImplementation(async (descriptor: {
        workspaceId: string;
        rootPath: string | null;
        filePath: string;
        documentUri?: string | null;
      }) => {
        const normalizedFilePath = descriptor.filePath.replace(/\\/g, "/");
        const absolutePath = descriptor.rootPath && !normalizedFilePath.startsWith("/")
          ? `${descriptor.rootPath.replace(/\/$/, "")}/${normalizedFilePath}`
          : normalizedFilePath;
        let openResultIndex = -1;
        for (let index = lspMocks.lspOpenDocument.mock.calls.length - 1; index >= 0; index -= 1) {
          const openedDescriptor = lspMocks.lspOpenDocument.mock.calls[index]?.[0] as typeof descriptor | undefined;
          if (
            openedDescriptor?.workspaceId === descriptor.workspaceId
            && openedDescriptor.rootPath === descriptor.rootPath
            && openedDescriptor.filePath === descriptor.filePath
            && openedDescriptor.documentUri === descriptor.documentUri
          ) {
            openResultIndex = index;
            break;
          }
        }
        const openResult = openResultIndex >= 0
          ? lspMocks.lspOpenDocument.mock.results[openResultIndex]
          : undefined;
        const openedStatus = openResult?.type === "return"
          ? await openResult.value as LspDocumentStatus | undefined
          : undefined;
        return {
          status: openedStatus ?? documentStatus({
            path: absolutePath,
            uri: descriptor.documentUri ?? `file://${absolutePath.startsWith("/") ? "" : "/"}${absolutePath}`,
          }),
          diagnostics: [],
        };
      });
      workspaceMocks.workspaceListDir.mockResolvedValue([]);
      workspaceMocks.workspaceCompactChain.mockResolvedValue({ path: "", entries: [] });
      workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([]);
      workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([]);
      workspaceMocks.workspaceDetectTasks.mockResolvedValue([]);
      gitMocks.gitSnapshot.mockResolvedValue({
        repoRoot: "/repo/app",
        currentBranch: "main",
        headOid: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        changes: [],
        remotes: [],
        branches: [],
        stashes: [],
        tags: [],
        settings: {
          userName: null,
          userEmail: null,
          httpProxy: null,
          httpsProxy: null,
          pullRebase: null,
          pushDefault: null,
          coreAutocrlf: null,
          coreFilemode: null,
          commitGpgsign: null,
        },
      });
      gitMocks.gitIgnorePath.mockResolvedValue({
        rule: "/README.md",
        gitignorePath: "/repo/app/.gitignore",
        added: true,
      });
      gitMocks.gitBlobPair.mockResolvedValue({
        path: "src/main.ts",
        oldPath: null,
        oldText: "",
        newText: null,
        oldExists: true,
        newExists: false,
        binary: false,
        image: false,
        oldImageB64: null,
        newImageB64: null,
        oversize: false,
        oldSize: 0,
        newSize: 0,
      });
      gitMocks.gitBlameLines.mockResolvedValue([]);
    });

    afterEach(() => {
      cleanup();
      workspaceActionRegistry.clear();
      globalEditorConfigResolver.clearAll();
      clearGitSnapshotCache();
      clearGitSnapshotInFlight();
    });

    registerInteractionCases({
      get projectFactsMock() { return projectFactsMock; },
      get descriptorDiscoveryMock() { return descriptorDiscoveryMock; },
      get renderWorkspace() { return renderWorkspace; },
      get clipboardMocks() { return clipboardMocks; },
      get workspaceMocks() { return workspaceMocks; },
      get entry() { return entry; },
      get file() { return file; },
      get gitMocks() { return gitMocks; },
      get toolbarControl() { return toolbarControl; },
      get documentStatus() { return documentStatus; },
      get lspMocks() { return lspMocks; },
      get defaultCapabilities() { return defaultCapabilities; },
      get writeAck() { return writeAck; },
      get runtimeState() { return runtimeState; },
      get dapMocks() { return dapMocks; },
      get ipcMocks() { return ipcMocks; },
      get localHistoryMocks() { return localHistoryMocks; },
      get confirmWorkspaceUndo() { return confirmWorkspaceUndo; },
    });
    registerFilesCases({
      get renderWorkspace() { return renderWorkspace; },
      get workspaceMocks() { return workspaceMocks; },
      get file() { return file; },
      get toolbarControl() { return toolbarControl; },
      get entry() { return entry; },
      get gitMocks() { return gitMocks; },
      get lspMocks() { return lspMocks; },
      get documentStatus() { return documentStatus; },
      get defaultCapabilities() { return defaultCapabilities; },
      get clipboardMocks() { return clipboardMocks; },
      get writeAck() { return writeAck; },
      get confirmWorkspaceUndo() { return confirmWorkspaceUndo; },
    });
    registerLanguageCases({
      get workspaceMocks() { return workspaceMocks; },
      get entry() { return entry; },
      get file() { return file; },
      get lspMocks() { return lspMocks; },
      get csharpStatus() { return csharpStatus; },
      get documentStatus() { return documentStatus; },
      get renderWorkspace() { return renderWorkspace; },
      get settingsNavigationMocks() { return settingsNavigationMocks; },
      get writeAck() { return writeAck; },
      get defaultCapabilities() { return defaultCapabilities; },
      get toolbarControl() { return toolbarControl; },
      get runtimeState() { return runtimeState; },
      get dapMocks() { return dapMocks; },
    });
    registerLayoutCases({
      get workspaceMocks() { return workspaceMocks; },
      get entry() { return entry; },
      get file() { return file; },
      get renderWorkspace() { return renderWorkspace; },
      get lspMocks() { return lspMocks; },
      get csharpStatus() { return csharpStatus; },
      get documentStatus() { return documentStatus; },
      get toolbarControl() { return toolbarControl; },
    });
    registerWorkspaceEditsCases({
      get workspaceMocks() { return workspaceMocks; },
      get file() { return file; },
      get renderWorkspace() { return renderWorkspace; },
      get entry() { return entry; },
      get writeAck() { return writeAck; },
      get lspMocks() { return lspMocks; },
      get documentStatus() { return documentStatus; },
      get confirmWorkspaceUndo() { return confirmWorkspaceUndo; },
      get runtimeState() { return runtimeState; },
      get dapMocks() { return dapMocks; },
      get csharpStatus() { return csharpStatus; },
      get toolbarControl() { return toolbarControl; },
      get defaultCapabilities() { return defaultCapabilities; },
    });
    registerSaveCases({
      get documentStatus() { return documentStatus; },
      get defaultCapabilities() { return defaultCapabilities; },
      get workspaceMocks() { return workspaceMocks; },
      get file() { return file; },
      get lspMocks() { return lspMocks; },
      get renderWorkspace() { return renderWorkspace; },
      get writeAck() { return writeAck; },
      get entry() { return entry; },
      get runtimeState() { return runtimeState; },
      get csharpStatus() { return csharpStatus; },
      get toolbarControl() { return toolbarControl; },
      get localHistoryMocks() { return localHistoryMocks; },
      get saveCommitObservations() { return saveCommitObservations; },
      get saveRaceGate() { return saveRaceGate; },
      get clipboardMocks() { return clipboardMocks; },
    });

    // V-ALT-01: Linux WebKitGTK reports real chords such as Alt+Enter as
    // key="Unidentified" with a physical code. The unified dispatcher must still
    // open the Code Actions menu and leave the buffer untouched.
    it.each(["Enter", "Unidentified"])("opens code actions under StrictMode for Alt+Enter key=%s", async (key) => {
      const instanceId = `instance-actions-alt-enter-${key}`;
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-actions-alt-enter-${key}`,
        workspaceInstanceId: instanceId,
        name: "Actions Linux",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
        path: "/repo/app/src/main.ts",
        uri: "file:///repo/app/src/main.ts",
        available: true,
        active: true,
        capabilities: defaultCapabilities({ codeAction: true }),
      }));
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [{
          title: "Insert space",
          kind: "quickfix",
          isPreferred: true,
          edit: null,
          command: null,
          commandArguments: null,
          raw: { title: "Insert space", data: { fixId: "space" } },
        }],
      });

      const rendered = renderWorkspace(workspace, {}, { strict: true });
      await screen.findByTitle("app / src/main.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await waitFor(() => expect(rendered.container.querySelector(".cm-content")).not.toBeNull());

      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      content.focus();
      fireEvent.keyDown(content, { key, code: "Enter", altKey: true });

      expect(await screen.findByRole("button", { name: "Insert space" })).toBeInTheDocument();
      expect(lspMocks.lspCodeActions).toHaveBeenCalled();
      // Focus and buffer stay untouched: no newline was inserted.
      expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instanceId,
      ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
    });

    // ED-AUDIT-008 A1/A3: after an intention apply, Ctrl+Z on the editor
    // surface must run the journal undo — one history unit with its verified
    // restore — instead of colliding with the document ledger, and a follow-up
    // Ctrl+Z must not re-apply the change the journal just undid.

    // ED-AUDIT-008 A2: a provider command that fails AFTER the WorkspaceEdit
    // landed must not be reported as a zero-effect success — the already-written
    // text is automatically recovered and the status message names both the
    // failure and the performed recovery, and the failed run registers no
    // undoable history entry.

    // ED-AUDIT-008 A2: a resolve that returns null keeps the file untouched and
    // shows the retryable resolve-failure result instead of a generic error.

    // ED-AUDIT-008 A1 regression: jdtls keeps reporting work-done progress while
    // the candidates are requested and applied, so the semantic snapshot is
    // still "building" with an active provider at both gates. Background
    // provider progress must not stale a revision-pinned response — pre-fix the
    // strict build gate blocked the menu ("Refactor actions became stale…") or
    // aborted the apply ("Semantic result became stale before changes were
    // applied") on roughly half of the native runs. The workspace revision is
    // unchanged throughout, so the menu must open and the apply must land.

    // ED-PARITY-007 DEC-05: the Rust/TS failure classification change must not
    // turn a provider failure into a silent "no actions" claim, and must never
    // block the user's save.

    // ED-AUDIT-009 A1: two real leaves of one file share ONE logical history —
    // an edit in either leaf reaches the other in real time without clobbering
    // its caret/scroll, and one undo/redo stroke issued from one leaf reverts
    // (re-applies) in both leaves through the production keymap routing.

    // ED-AUDIT-009 A2: closing a non-last leaf keeps text AND history in the
    // survivor (no didClose, no save); the last dirty view's cancel is a zero
    // effect; confirming the discard closes without writing; the closed-tab
    // reopen reads the saved disk bytes — discarded text is not revived.

    // ED-PARITY-003 S0..S7: one file preview→formal→split→independent
    // selection→shared edit→single undo→close non-last keeps the survivor
    // alive. The S1b typing-promotion assertion is the regression: the baseline
    // kept the preview italic/dirty-false split (memo-skipped onChange) instead
    // of promoting to formal like IDEA R1.

  });
}
