import { useEffect, useRef, useState } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { WorkspaceHostIntegration } from "../workspaceHostIntegration";
import { fileKey, type OpenFileState } from "../codeWorkspaceModel";
import type { useWorkspaceSession } from "./useWorkspaceSession";
import type { useWorkspaceProjectRuntime } from "./useWorkspaceProjectRuntime";
import type { useWorkspaceFileOpening } from "./useWorkspaceFileOpening";
import type { useWorkspaceDocumentEditing } from "./useWorkspaceDocumentEditing";
import { useWorkspaceHostCanvas } from "./useWorkspaceHostCanvas";

interface Dependencies {
  host?: WorkspaceHostIntegration;
  session: ReturnType<typeof useWorkspaceSession>;
  project: ReturnType<typeof useWorkspaceProjectRuntime>;
  files: ReturnType<typeof useWorkspaceFileOpening>;
  editing: ReturnType<typeof useWorkspaceDocumentEditing>;
}

/** Host requests share the editor's normal buffer, close, recovery and LSP owners. */
export function useWorkspaceHostFiles(dependencies: Dependencies) {
  const { host, session, project, files } = dependencies;
  const live = useRef(dependencies);
  live.current = dependencies;
  const applying = useRef(false);
  const [settledRequest, setSettledRequest] = useState<string | null>(null);
  const request = host ? JSON.stringify({ files: host.files, active: host.activeFile }) : null;
  const requestRef = useRef(request);
  requestRef.current = request;
  const recovered = useRef(new Set<string>());
  const previousWanted = useRef<Set<string> | null>(null);
  const queue = useRef(Promise.resolve());
  const rootIds = project.projectTree.roots.map((root) => root.id).join("\n");
  useWorkspaceHostCanvas(host, session.workspaceInstanceId, !applying.current && settledRequest === request && files.restoreReady);

  useEffect(() => {
    if (!host || request === null || !files.restoreReady) return;
    // Adding a root updates the editor's tree on its next commit. Do not read
    // against an empty root or publish a partial restore back to the host.
    if (host.files.some((ref) => ref.kind === "root" && !project.projectTree.roots.some((root) => root.id === ref.rootId))) return;
    const requested = host;
    let cancelled = false;
    const isCurrent = () => !cancelled && requestRef.current === request && live.current.session.mountedRef.current;
    applying.current = true;
    queue.current = queue.current.catch(() => undefined).then(async () => {
      if (!isCurrent()) return;
      const current = live.current;
      const wanted = new Set(requested.files.map(fileKey));
      for (const ref of requested.files) {
        if (!isCurrent()) return;
        const key = fileKey(ref);
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), current.session.workspaceInstanceId);
        const groupId = Object.values(ui.editorGroups).find((group) => group.openOrder.includes(key))?.id;
        await current.files.openFile(ref, { preview: false, activate: false, restoring: true, groupId, isCurrent });
        if (!isCurrent()) return;
        const draft = !recovered.current.has(key) ? requested.recoverDraft(ref) : null;
        const buffer = current.session.bufferState.openFilesRef.current[key];
        if (draft && buffer && !buffer.loading && !buffer.dirty) {
          const restored = { ...buffer, text: draft.text, savedText: draft.savedText,
            hash: draft.hash ?? buffer.hash, dirty: true, documentRevision: buffer.documentRevision + 1 };
          current.project.buffers.setOpenFiles((buffers) => ({ ...buffers, [key]: restored }));
          recovered.current.add(key);
          // The platform has restored this same draft automatically. Do not
          // also interrupt the user with the editor's duplicate recovery row.
          // Different snapshots and unresolved disk effects still need review.
          const recovery = current.project.recoveryState;
          const matching = recovery.workspaceRecoveryEntries.find((entry) => entry.key === key && entry.text === draft.text);
          if (matching) {
            recovery.pendingWorkspaceRecoveryKeysRef.current.delete(key);
            recovery.setWorkspaceRecoveryEntries((entries) => entries.filter((entry) => entry.key !== key));
            if (!recovery.pendingWorkspaceRecoveryKeysRef.current.size && !recovery.diskEffectLedgerEntries.length) {
              recovery.setWorkspaceRecoveryOpen(false);
            }
          }
          if (!restored.error && current.session.bufferState.lspFilesRef.current[key]?.status?.active) {
            await current.project.lsp.syncDocument(restored, "change");
          }
        }
      }
      // A new file opened inside the editor is published below, never treated
      // as an external close. Close only files removed from a previous host list.
      const removed = [...(previousWanted.current ?? [])].filter((key) => !wanted.has(key));
      for (const key of removed) {
        if (!isCurrent()) return;
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), current.session.workspaceInstanceId);
        for (const group of Object.values(ui.editorGroups)) {
          if (!group.openOrder.includes(key)) continue;
          await current.editing.fileLifecycle.closeFile(key, group.id);
          if (!isCurrent()) return;
        }
      }
      previousWanted.current = wanted;
      if (!isCurrent()) return;
      if (requested.activeFile) {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), current.session.workspaceInstanceId);
        const key = fileKey(requested.activeFile);
        // Reuse its existing split; selecting an outer tab must not duplicate
        // a buffer in whichever editor group happened to have focus before.
        const groupId = ui.editorGroups[ui.activeEditorGroupId]?.openOrder.includes(key) ? ui.activeEditorGroupId
          : Object.values(ui.editorGroups).find((group) => group.openOrder.includes(key))?.id;
        if (ui.activeKey !== key) await current.files.openFile(requested.activeFile, { preview: false, restoring: true, groupId, isCurrent });
      }
      if (isCurrent()) {
        current.project.buffers.flushPendingEditorText();
        applying.current = false;
        setSettledRequest(request);
      }
    }).catch((error) => {
      if (isCurrent()) {
        applying.current = false;
        live.current.session.setStatusMessage(String(error));
        setSettledRequest(request);
      }
    });
    return () => { cancelled = true; };
  }, [request, rootIds, files.restoreReady]);

  useEffect(() => {
    if (!host || applying.current || settledRequest !== request) return;
    const openFiles = session.workspaceUi.openOrder.map((key) => session.workspaceUi.openFiles[key])
      .filter((file): file is OpenFileState => !!file && !file.library && file.ref.kind === "root");
    if (openFiles.some((file) => file.loading)) return;
    const active = session.workspaceUi.openFiles[session.workspaceUi.activeKey ?? ""];
    host.onSnapshot({ files: openFiles, activeFile: active?.ref ?? null });
  }, [host, request, settledRequest, session.workspaceUi.openFiles, session.workspaceUi.openOrder, session.workspaceUi.activeKey]);
}
