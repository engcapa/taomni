import { useEffect, useRef } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { WorkspaceHostIntegration } from "../workspaceHostIntegration";
import { fileKey, type OpenFileState } from "../codeWorkspaceModel";
import type { useWorkspaceSession } from "./useWorkspaceSession";
import type { useWorkspaceProjectRuntime } from "./useWorkspaceProjectRuntime";
import type { useWorkspaceFileOpening } from "./useWorkspaceFileOpening";
import type { useWorkspaceDocumentEditing } from "./useWorkspaceDocumentEditing";
import { useWorkspaceHostCanvas } from "./useWorkspaceHostCanvas";

type Session = ReturnType<typeof useWorkspaceSession>;
type Project = ReturnType<typeof useWorkspaceProjectRuntime>;

export interface WorkspaceHostFilesDependencies {
  host?: WorkspaceHostIntegration;
  session: Pick<Session, "workspaceInstanceId" | "mountedRef" | "workspaceUi" | "setStatusMessage"> & {
    bufferState: Pick<Session["bufferState"], "openFilesRef" | "lspFilesRef">;
  };
  project: {
    projectTree: Pick<Project["projectTree"], "roots">;
    buffers: Pick<Project["buffers"], "setOpenFiles" | "flushPendingEditorText">;
    recoveryState: Pick<Project["recoveryState"], "workspaceRecoveryEntries" | "pendingWorkspaceRecoveryKeysRef" | "setWorkspaceRecoveryEntries" | "diskEffectLedgerEntries" | "setWorkspaceRecoveryOpen">;
    lsp: Pick<Project["lsp"], "syncDocument">;
  };
  files: Pick<ReturnType<typeof useWorkspaceFileOpening>, "openFile" | "restoreReady">;
  editing: { fileLifecycle: Pick<ReturnType<typeof useWorkspaceDocumentEditing>["fileLifecycle"], "closeFile"> };
}

function publishSnapshot(host: WorkspaceHostIntegration, workspaceInstanceId: string) {
  const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
  const keys = [...new Set(Object.values(ui.editorGroups).flatMap((group) => group.openOrder))];
  const files = keys.map((key) => ui.openFiles[key])
    .filter((file): file is OpenFileState => !!file && !file.library && file.ref.kind === "root");
  if (files.some((file) => file.loading)) return;
  host.onSnapshot({ files, activeFile: ui.openFiles[ui.activeKey ?? ""]?.ref ?? null });
}

/** Host requests share the editor's normal buffer, close, recovery and LSP owners. */
export function useWorkspaceHostFiles(dependencies: WorkspaceHostFilesDependencies) {
  const { host, session, project, files } = dependencies;
  const live = useRef(dependencies);
  live.current = dependencies;
  const applying = useRef(false);
  const settledRequest = useRef<string | null>(null);
  const request = host ? JSON.stringify({ files: host.files, active: host.activeFile }) : null;
  const requestRef = useRef(request);
  requestRef.current = request;
  const recovered = useRef(new Set<string>());
  const previousWanted = useRef<Set<string> | null>(null);
  const queue = useRef(Promise.resolve());
  const rootIds = project.projectTree.roots.map((root) => root.id).join("\n");
  const reconcileCanvas = useWorkspaceHostCanvas(host, session.workspaceInstanceId,
    !applying.current && settledRequest.current === request && files.restoreReady);

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
      const initialUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), current.session.workspaceInstanceId);
      // Reload can interrupt an outer-tab close before the editor effect saves
      // its layout. The host's restored file list owns root tabs; reconcile
      // stale layout entries through the normal close/recovery owner as well.
      const previous = previousWanted.current ?? new Set(Object.values(initialUi.editorGroups)
        .flatMap((group) => group.openOrder)
        .filter((key) => initialUi.openFiles[key]?.ref.kind === "root"));
      previousWanted.current = new Set(previous);
      for (const ref of requested.files) {
        if (!isCurrent()) return;
        const key = fileKey(ref);
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), current.session.workspaceInstanceId);
        const groupId = Object.values(ui.editorGroups).find((group) => group.openOrder.includes(key))?.id;
        // Selection-only host updates must not reinsert a file closed inside
        // the editor while this reconciliation was queued. Its next snapshot
        // will remove that outer tab. Existing buffers need no redundant open.
        if (!groupId && previous.has(key)) continue;
        if (groupId) previousWanted.current.add(key);
        if (!groupId || !ui.openFiles[key] || ui.openFiles[key].loading) {
          try {
            await current.files.openFile(ref, { preview: false, activate: false, restoring: true, groupId, isCurrent });
          } finally {
            // Retain a committed placeholder even if this request was replaced.
            // A cancelled read with no tab remains eligible for the next open.
            const after = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), current.session.workspaceInstanceId);
            if (Object.values(after.editorGroups).some((group) => group.openOrder.includes(key))) {
              previousWanted.current?.add(key);
            }
          }
        }
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
            // The LSP owner serializes document notifications itself. A slow
            // provider must not hold the host file/selection reconciliation.
            void current.project.lsp.syncDocument(restored, "change");
          }
        }
      }
      // A new file opened inside the editor is published below. Only restored
      // or previously host-owned files can become external close requests.
      const removed = [...previous].filter((key) => !wanted.has(key));
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
        if (groupId && ui.activeKey !== key) await current.files.openFile(requested.activeFile, { preview: false, restoring: true, groupId, isCurrent });
      }
      if (isCurrent()) {
        current.project.buffers.flushPendingEditorText();
        applying.current = false;
        settledRequest.current = request;
        reconcileCanvas(requested);
        publishSnapshot(requested, current.session.workspaceInstanceId);
      }
    }).catch((error) => {
      if (isCurrent()) {
        applying.current = false;
        live.current.session.setStatusMessage(String(error));
        settledRequest.current = request;
        reconcileCanvas(requested);
        publishSnapshot(requested, live.current.session.workspaceInstanceId);
      }
    });
    return () => { cancelled = true; };
  }, [request, rootIds, files.restoreReady, reconcileCanvas]);

  useEffect(() => {
    if (!host || applying.current || settledRequest.current !== request) return;
    publishSnapshot(host, session.workspaceInstanceId);
  }, [host, request, session.workspaceInstanceId, session.workspaceUi.openFiles, session.workspaceUi.editorGroups, session.workspaceUi.activeKey]);
}
