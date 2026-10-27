import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  lspChangeDocument,
  lspCloseDocument,
  lspDetectServers,
  lspGetDiagnostics,
  lspOpenDocument,
  lspSaveDocument,
  lspSetJavaBundles,
  lspSetJavaHome,
  lspSetJavaSettings,
  lspSetJavaVmargs,
  lspStopWorkspace,
  type LspDocumentDescriptor,
  type LspDocumentStatus,
  type LspServerStatus,
} from "../../../../lib/editor/lsp";
import { subscribeSdkRegistryChanged } from "../../../../lib/editor/sdk";
import {
  CUSTOM_LSP_COMMAND_ID,
  customServerCommandFromConfig,
  emptyLspFileState,
  errorMessage,
  lspPresetIdForPath,
  readLspCommandPrefs,
  readLspCustomCommands,
  readLspJavaHome,
  readLspJavaSettings,
  readLspJavaVmargs,
  subscribeLspServerPrefs,
  writeLspCommandPrefs,
  writeLspCustomCommands,
  type LspCustomCommandConfig,
  type OpenFileState,
} from "../codeWorkspaceModel";
import { isDiagnosticScopeCurrent, type DiagnosticScope } from "../diagnosticScopeModel";
import { buildIncrementalContentChange } from "../lspTextEdits";
import { resolveJavaBundles } from "./java";
import { type DocumentSyncQueue, type PendingDocumentSync, type UseWorkspaceLspSessionOptions, type WorkspaceLspSessionController } from "./model";
import {
  LSP_DIAGNOSTICS_IDLE_DELAY_MS,
  LSP_DIAGNOSTICS_REFRESH_EVENT,
  mergeDocumentCapabilities,
  nextErrorGeneration,
  sameDiagnostics,
  sameDocumentStatus,
} from "./state";

/** Centralizes the open/change/save/close lifecycle for one workspace instance. */
export function useWorkspaceLspSession({
  workspaceInstanceId,
  roots,
  openFilesRef,
  updateLspFiles,
  onError,
  onRestart,
  visible = true,
}: UseWorkspaceLspSessionOptions): WorkspaceLspSessionController {
  const [serverStatuses, setServerStatuses] = useState<LspServerStatus[]>([]);
  const [commandPrefs, setCommandPrefs] = useState<Record<string, string>>(() => readLspCommandPrefs());
  const [customCommands, setCustomCommands] = useState<Record<string, LspCustomCommandConfig>>(
    () => readLspCustomCommands(),
  );
  const [javaHome, setJavaHome] = useState(() => readLspJavaHome());
  const rootsRef = useRef(roots);
  const versionRef = useRef<Record<string, number>>({});
  const sessionGenerationRef = useRef(0);
  const syncedTextRef = useRef<Record<string, string>>({});
  const incrementalSyncRef = useRef<Record<string, boolean>>({});
  /** Last known server-active flag per file (avoids store peeks before didChange). */
  const documentActiveRef = useRef<Record<string, boolean>>({});
  const diagnosticsTimersRef = useRef<Record<string, number>>({});
  const diagnosticsRequestSequenceRef = useRef<Record<string, number>>({});
  const syncQueuesRef = useRef<Record<string, DocumentSyncQueue>>({});
  const mountedRef = useRef(true);
  const visibleRef = useRef(visible);
  const serverRefreshSequenceRef = useRef(0);
  const previousVisibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      Object.values(syncQueuesRef.current).forEach((queue) => { queue.closed = true; });
      syncQueuesRef.current = {};
      syncedTextRef.current = {};
      incrementalSyncRef.current = {};
      documentActiveRef.current = {};
      diagnosticsRequestSequenceRef.current = {};
      Object.values(diagnosticsTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      diagnosticsTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    serverRefreshSequenceRef.current += 1;
  }, [visible]);

  useEffect(() => () => {
    void lspStopWorkspace(workspaceInstanceId);
  }, [workspaceInstanceId]);

  const refreshServerStatuses = useCallback(async (forceRefresh = false) => {
    const requestSequence = ++serverRefreshSequenceRef.current;
    const isCurrentRequest = () => (
      mountedRef.current
      && visibleRef.current
      && serverRefreshSequenceRef.current === requestSequence
    );
    if (!isCurrentRequest()) return;
    try {
      const home = readLspJavaHome().trim();
      if (!isCurrentRequest()) return;
      await lspSetJavaHome(home || null);
      if (!isCurrentRequest()) return;
      await lspSetJavaVmargs(readLspJavaVmargs());
      if (!isCurrentRequest()) return;
      await lspSetJavaSettings(readLspJavaSettings());
      if (!isCurrentRequest()) return;
      const javaBundles = await resolveJavaBundles();
      if (!isCurrentRequest()) return;
      await lspSetJavaBundles(javaBundles);
      if (!isCurrentRequest()) return;
      const statuses = await lspDetectServers({ javaHome: home || null, forceRefresh });
      // A provider that resolves null (or a non-array) must degrade to "no
      // servers", not crash the workspace tab render (serverStatuses.find
      // assumes an array).
      if (isCurrentRequest()) setServerStatuses(Array.isArray(statuses) ? statuses : []);
    } catch (error) {
      if (isCurrentRequest()) onError(errorMessage(error));
    }
  }, [onError]);

  useEffect(() => {
    const becameVisible = !previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (!visible) return;
    void refreshServerStatuses(becameVisible);
  }, [refreshServerStatuses, visible]);

  const restartWorkspaceServers = useCallback(() => {
    if (!mountedRef.current) return;
    onRestart?.();
    // Session generation: every restart invalidates completion/resolve
    // requests minted against the previous provider session (§8.16.2).
    sessionGenerationRef.current += 1;
    syncedTextRef.current = {};
    incrementalSyncRef.current = {};
    documentActiveRef.current = {};
    versionRef.current = {};
    updateLspFiles((current) => Object.fromEntries(
      Object.entries(current).map(([key, state]) => [key, {
        ...state,
        diagnostics: [],
        diagnosticScope: null,
        syncedText: null,
      }]),
    ));
    // SDK and language settings restart providers while the explorer still
    // owns its file watcher. Only workspace disposal should stop both.
    void lspStopWorkspace(workspaceInstanceId, true)
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) void refreshServerStatuses(true);
      });
  }, [onRestart, refreshServerStatuses, updateLspFiles, workspaceInstanceId]);

  // Settings is the primary editor for LSP preferences. Keep open workspaces
  // in sync without remounting and restart servers so command/runtime changes
  // take effect for already-open documents.
  useEffect(() => subscribeLspServerPrefs(() => {
    setCommandPrefs(readLspCommandPrefs());
    setCustomCommands(readLspCustomCommands());
    setJavaHome(readLspJavaHome());
    restartWorkspaceServers();
  }), [restartWorkspaceServers]);

  // SDK defaults and workspace bindings affect process environments and the
  // LSP session fingerprint. Restart now instead of waiting for another file
  // to be opened before the selected project/tooling SDK becomes effective.
  useEffect(() => subscribeSdkRegistryChanged(() => {
    restartWorkspaceServers();
  }), [restartWorkspaceServers]);

  const invalidateSyncedText = useCallback(() => {
    syncedTextRef.current = {};
    incrementalSyncRef.current = {};
    documentActiveRef.current = {};
    updateLspFiles((current) => Object.fromEntries(
      Object.entries(current).map(([key, state]) => [key, { ...state, syncedText: null }]),
    ));
  }, [updateLspFiles]);

  const updateCommandPref = useCallback((presetId: string, commandId: string) => {
    setCommandPrefs((current) => {
      const next = { ...current, [presetId]: commandId };
      writeLspCommandPrefs(next);
      return next;
    });
    invalidateSyncedText();
  }, [invalidateSyncedText]);

  const updateCustomCommand = useCallback((presetId: string, patch: Partial<LspCustomCommandConfig>) => {
    setCustomCommands((current) => {
      const existing = current[presetId] ?? { command: "", args: "" };
      const nextConfig = { ...existing, ...patch };
      const next = { ...current };
      if (nextConfig.command.trim() || nextConfig.args.trim()) next[presetId] = nextConfig;
      else delete next[presetId];
      writeLspCustomCommands(next);
      return next;
    });
    invalidateSyncedText();
  }, [invalidateSyncedText]);

  const descriptorForPath = useCallback((
    rootPath: string | null,
    filePath: string,
    documentUri: string | null = null,
  ): LspDocumentDescriptor => {
    const presetId = lspPresetIdForPath(filePath);
    const commandPref = presetId ? commandPrefs[presetId] ?? null : null;
    const serverCommandId = commandPref && commandPref !== CUSTOM_LSP_COMMAND_ID ? commandPref : null;
    const customServerCommand = presetId && commandPref === CUSTOM_LSP_COMMAND_ID
      ? customServerCommandFromConfig(customCommands[presetId])
      : null;
    return {
      workspaceId: workspaceInstanceId,
      rootPath,
      filePath,
      documentUri,
      serverCommandId,
      customServerCommand,
      javaHome: javaHome.trim() || null,
    };
  }, [commandPrefs, customCommands, javaHome, workspaceInstanceId]);

  const descriptorForFile = useCallback((file: OpenFileState): LspDocumentDescriptor | null => {
    // Library sources (jdt:// JDK / JAR classes) have no file of their own: keep the
    // origin project's path so the request lands on that project's session, and let
    // the server resolve the class from the virtual URI.
    if (file.library) {
      return descriptorForPath(
        file.library.originRootPath,
        file.library.originFilePath,
        file.library.uri,
      );
    }
    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      const root = rootsRef.current.find((candidate) => candidate.id === rootId);
      if (!root) return null;
      return descriptorForPath(root.path, file.ref.path);
    }
    return descriptorForPath(null, file.ref.path);
  }, [descriptorForPath]);

  const updateStatus = useCallback((file: OpenFileState, status: LspDocumentStatus) => {
    if (!mountedRef.current) return;
    documentActiveRef.current[file.key] = status.active;
    updateLspFiles((current) => {
      const existing = current[file.key] ?? emptyLspFileState();
      const effectiveCapabilities = mergeDocumentCapabilities(status.capabilities, existing.status?.capabilities);
      const effectiveStatus: LspDocumentStatus = effectiveCapabilities !== status.capabilities
        ? { ...status, capabilities: effectiveCapabilities }
        : status;
      const currentRevision = openFilesRef.current[file.key]?.documentRevision;
      const existingScope = existing.diagnosticScope;
      const preserveDiagnostics = !!existingScope
        && effectiveStatus.active
        && currentRevision !== undefined
        && existingScope.revision === currentRevision
        && existingScope.providerId === effectiveStatus.presetId
        && existingScope.providerGeneration === sessionGenerationRef.current
        && existingScope.uri === (effectiveStatus.uri || null);
      const diagnosticsUnchanged = (existing.diagnostics.length === 0 && existingScope === null)
        || preserveDiagnostics;
      if (existing.status && sameDocumentStatus(existing.status, effectiveStatus)
        && diagnosticsUnchanged
        && !existing.syncing && existing.error === null) {
        return current;
      }
      return {
        ...current,
        [file.key]: {
          ...existing,
          status: effectiveStatus,
          ...(preserveDiagnostics ? {} : { diagnostics: [], diagnosticScope: null }),
          syncing: false,
          error: null,
          errorGeneration: nextErrorGeneration(existing, effectiveStatus.error, null),
        },
      };
    });
  }, [openFilesRef, updateLspFiles]);

  const refreshDiagnostics = useCallback(async (file: OpenFileState) => {
    // Library sources are never opened on the server, so they publish no diagnostics.
    if (file.library) return;
    const descriptor = descriptorForFile(file);
    if (!descriptor) return;
    const requestRevision = file.documentRevision ?? openFilesRef.current[file.key]?.documentRevision ?? 0;
    const requestGeneration = sessionGenerationRef.current;
    const requestSequence = (diagnosticsRequestSequenceRef.current[file.key] ?? 0) + 1;
    diagnosticsRequestSequenceRef.current[file.key] = requestSequence;
    const isCurrentRequest = () => (
      mountedRef.current
      && !!openFilesRef.current[file.key]
      && openFilesRef.current[file.key]?.documentRevision === requestRevision
      && sessionGenerationRef.current === requestGeneration
      && diagnosticsRequestSequenceRef.current[file.key] === requestSequence
    );
    try {
      const result = await lspGetDiagnostics(descriptor);
      if (!isCurrentRequest()) return;
      updateLspFiles((current) => {
        if (!isCurrentRequest()) return current;
        const existing = current[file.key] ?? emptyLspFileState();
        if (existing.status?.active && existing.status.presetId !== result.status.presetId) return current;
        const nextScope: DiagnosticScope | null = result.status.active
          ? {
            fileKey: file.key,
            revision: requestRevision,
            providerId: result.status.presetId,
            providerGeneration: requestGeneration,
            uri: result.status.uri || descriptor.documentUri || descriptor.filePath || null,
          }
          : null;
        const statusUnchanged = existing.status
          ? sameDocumentStatus(existing.status, result.status)
          : false;
        if (
          statusUnchanged
          && sameDiagnostics(existing.diagnostics, result.status.active ? result.diagnostics : [])
          && (nextScope === null
            ? existing.diagnosticScope === null
            : isDiagnosticScopeCurrent(existing.diagnosticScope, nextScope))
          && !existing.syncing
          && existing.error === null
        ) {
          return current;
        }
        return {
          ...current,
          [file.key]: {
            ...existing,
            status: result.status,
            diagnostics: result.status.active ? result.diagnostics : [],
            diagnosticScope: nextScope,
            syncing: false,
            error: null,
            errorGeneration: nextErrorGeneration(existing, result.status.error, null),
          },
        };
      });
    } catch (error) {
      if (!isCurrentRequest()) return;
      updateLspFiles((current) => {
        if (!isCurrentRequest()) return current;
        const existing = current[file.key] ?? emptyLspFileState();
        const message = errorMessage(error);
        if (!existing.syncing && existing.error === message) return current;
        return {
          ...current,
          [file.key]: {
            ...existing,
            diagnostics: [],
            diagnosticScope: null,
            syncing: false,
            error: message,
            errorGeneration: nextErrorGeneration(existing, null, message),
          },
        };
      });
    }
  }, [descriptorForFile, openFilesRef, updateLspFiles]);

  const scheduleDiagnostics = useCallback((key: string) => {
    const existing = diagnosticsTimersRef.current[key];
    if (existing) window.clearTimeout(existing);
    diagnosticsTimersRef.current[key] = window.setTimeout(() => {
      delete diagnosticsTimersRef.current[key];
      const latest = openFilesRef.current[key];
      // Only poll diagnostics while the server is actually serving this file.
      if (!latest || !documentActiveRef.current[key]) return;
      void refreshDiagnostics(latest);
    }, LSP_DIAGNOSTICS_IDLE_DELAY_MS);
  }, [openFilesRef, refreshDiagnostics]);

  // LSP 3.17 pull providers can invalidate their cached report at any time
  // (for example after a build or dependency refresh). The backend forwards
  // `workspace/diagnostic/refresh`; refresh every currently open, active
  // document immediately instead of waiting for the idle timer.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<{ workspaceId?: unknown; }>(LSP_DIAGNOSTICS_REFRESH_EVENT, (event) => {
      if (event.payload?.workspaceId !== workspaceInstanceId) return;
      for (const file of Object.values(openFilesRef.current)) {
        if (file.library || !documentActiveRef.current[file.key]) continue;
        void refreshDiagnostics(file);
      }
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openFilesRef, refreshDiagnostics, workspaceInstanceId]);

  /**
   * Live didChange traffic must not thrash the status pill spinner. Only show
   * "busy/starting" while the document is not yet active (first open or
   * server restart). Continuous typing otherwise keeps a queue.pending almost
   * always true, which used to leave the Java pill spinning on every key.
   */
  const isDocumentSynced = useCallback((key: string, text: string) => {
    if (syncedTextRef.current[key] !== text) return false;
    const queue = syncQueuesRef.current[key];
    return !queue || queue.closed;
  }, []);

  const documentVersion = useCallback((key: string) => versionRef.current[key] ?? null, []);

  const syncDocument = useCallback(async (file: OpenFileState, mode: "open" | "change") => {
    if (file.loading) return;
    // Library sources are owned by the server, not by us: no didOpen/didChange.
    if (file.library) return;
    // No language-server preset for this extension → never open an IPC path.
    if (!lspPresetIdForPath(file.languagePath)) return;
    // didChange without an active session (and not mid-open) is a no-op.
    if (
      mode === "change"
      && !documentActiveRef.current[file.key]
      && !syncQueuesRef.current[file.key]
    ) {
      return;
    }

    const running = syncQueuesRef.current[file.key];
    if (running) {
      running.pending = { file, mode };
      return;
    }

    const queue: DocumentSyncQueue = { closed: false, pending: null, waiters: [] };
    syncQueuesRef.current[file.key] = queue;
    let next: PendingDocumentSync | null = { file, mode };
    try {
      while (next && mountedRef.current && !queue.closed) {
        const currentSync: PendingDocumentSync = next;
        next = null;
        const descriptor = descriptorForFile(currentSync.file);
        if (!descriptor) break;
        const version = (versionRef.current[currentSync.file.key] ?? 0) + 1;
        versionRef.current[currentSync.file.key] = version;
        // Mark busy only for open / not-yet-active sessions. Active didChange
        // stays silent so the chrome does not re-render or spin per keystroke.
        const showBusy = currentSync.mode === "open"
          || !documentActiveRef.current[currentSync.file.key];
        if (showBusy) {
          updateLspFiles((current) => {
            const existing = current[currentSync.file.key] ?? emptyLspFileState();
            return {
              ...current,
              [currentSync.file.key]: {
                ...existing,
                syncing: true,
                error: null,
                // Drop a prior exit/start error so the pill can show "starting…"
                // for this attempt instead of the stale failure text.
                status: existing.status
                  ? { ...existing.status, error: null }
                  : existing.status,
              },
            };
          });
        }
        let active = false;
        try {
          const previousText = syncedTextRef.current[currentSync.file.key];
          const change = previousText === undefined
            ? null
            : buildIncrementalContentChange(previousText, currentSync.file.text);
          let status: LspDocumentStatus;
          if (currentSync.mode === "open") {
            status = await lspOpenDocument(descriptor, currentSync.file.text, version);
          } else {
            const omitFullText = incrementalSyncRef.current[currentSync.file.key] && change !== null;
            try {
              status = await lspChangeDocument(
                descriptor,
                omitFullText ? null : currentSync.file.text,
                version,
                change,
              );
            } catch (error) {
              if (!omitFullText) throw error;
              status = await lspChangeDocument(
                descriptor,
                currentSync.file.text,
                version,
                change,
              );
            }
          }
          active = status.active;
          documentActiveRef.current[currentSync.file.key] = active;
          const fileIsOpen = !!openFilesRef.current[currentSync.file.key];
          if (!mountedRef.current || queue.closed || !fileIsOpen) {
            if (mountedRef.current && (queue.closed || !fileIsOpen)) {
              void lspCloseDocument(descriptor);
            }
            break;
          }
          if (active) {
            syncedTextRef.current[currentSync.file.key] = currentSync.file.text;
            incrementalSyncRef.current[currentSync.file.key] =
              status.capabilities?.textDocumentSyncKind === 2;
          } else {
            // Unavailable / failed start: clear so typing does not keep a stale
            // "synced" view that features might misread.
            delete syncedTextRef.current[currentSync.file.key];
            delete incrementalSyncRef.current[currentSync.file.key];
          }
          const hasPending = queue.pending !== null;
          // Keep the spinner only while the server is still coming up. Once
          // active, mid-burst didChange completions stay out of the store so
          // typing does not re-render the whole workspace chrome; publish the
          // final syncedText when the queue drains.
          updateLspFiles((current) => {
            const existing = current[currentSync.file.key] ?? emptyLspFileState();
            const effectiveCapabilities = mergeDocumentCapabilities(status.capabilities, existing.status?.capabilities);
            const effectiveStatus: LspDocumentStatus = effectiveCapabilities !== status.capabilities
              ? { ...status, capabilities: effectiveCapabilities }
              : status;
            const nextSyncing = !active && hasPending;
            const statusUnchanged = !!existing.status
              && sameDocumentStatus(existing.status, effectiveStatus);
            // Typing burst: more keystrokes are already queued. syncedTextRef
            // tracks progress; skip the React/Zustand publish until drain.
            if (
              active
              && hasPending
              && statusUnchanged
              && existing.error === null
              && !existing.syncing
            ) {
              return current;
            }
            if (
              statusUnchanged
              && existing.syncedText === currentSync.file.text
              && existing.syncing === nextSyncing
              && existing.error === null
            ) {
              return current;
            }
            return {
              ...current,
              [currentSync.file.key]: {
                ...existing,
                status: effectiveStatus,
                diagnostics: existing.diagnostics,
                syncing: nextSyncing,
                syncedText: currentSync.file.text,
                error: null,
                errorGeneration: nextErrorGeneration(existing, effectiveStatus.error, null),
              },
            };
          });
          // Diagnostics only matter for a live server; avoid polling after a
          // failed open (missing binary) on every subsequent keystroke burst.
          if (active) scheduleDiagnostics(currentSync.file.key);
        } catch (error) {
          if (!mountedRef.current || queue.closed || !openFilesRef.current[currentSync.file.key]) break;
          updateLspFiles((current) => ({
            ...current,
            [currentSync.file.key]: {
              ...(current[currentSync.file.key] ?? emptyLspFileState()),
              // Errors surface immediately; do not leave a sticky spinner for
              // follow-up keystrokes that are merely queued.
              syncing: false,
              error: errorMessage(error),
              errorGeneration: nextErrorGeneration(
                current[currentSync.file.key] ?? emptyLspFileState(),
                null,
                errorMessage(error),
              ),
            },
          }));
        }
        next = queue.pending;
        queue.pending = null;
        if (next && active) next.mode = "change";
      }
    } finally {
      if (syncQueuesRef.current[file.key] === queue) delete syncQueuesRef.current[file.key];
      queue.waiters.splice(0).forEach((resolve) => resolve());
    }
  }, [descriptorForFile, openFilesRef, scheduleDiagnostics, updateLspFiles]);

  const waitForDocumentSyncQueue = useCallback(async (key: string) => {
    const queue = syncQueuesRef.current[key];
    if (!queue) return;
    await new Promise<void>((resolve) => queue.waiters.push(resolve));
  }, []);

  const saveDocument = useCallback(async (file: OpenFileState, text: string) => {
    if (file.library) return;
    const descriptor = descriptorForFile(file);
    if (!descriptor) return;
    // Eclipse JDT LS drops into a degraded completion state after
    // textDocument/didSave (empty list until the next didChange). Its completion
    // can also answer the first post-save query from the pre-edit document while
    // the save-triggered work is still settling, so the recovery didChange raced
    // the user's next keystrokes and the popup showed stale/irrelevant items.
    // The provider still learns about the save: the save flow notifies
    // workspace/didChangeWatchedFiles, which triggers the same JDT rebuild and
    // diagnostics, so we deliberately never send didSave to this provider.
    const providerSaveIsRedundant = lspPresetIdForPath(file.languagePath) === "java";
    try {
      // Preserve client message ordering: any queued didChange for the saved
      // text must land before the provider rebuilds, otherwise semantic queries
      // can observe a buffer that does not match what was written to disk.
      if (!isDocumentSynced(file.key, text)) {
        await syncDocument({ ...file, text }, "change");
        await waitForDocumentSyncQueue(file.key);
      }
      if (providerSaveIsRedundant) {
        if (!mountedRef.current || !openFilesRef.current[file.key]) return;
        updateLspFiles((current) => {
          const existing = current[file.key] ?? emptyLspFileState();
          return {
            ...current,
            [file.key]: {
              ...existing,
              syncing: false,
              syncedText: text,
              error: null,
              errorGeneration: nextErrorGeneration(existing, null, null),
            },
          };
        });
        scheduleDiagnostics(file.key);
        return;
      }
      const status = await lspSaveDocument(descriptor, text, versionRef.current[file.key] ?? 0);
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      // Provider behavior: Eclipse JDT LS serves an empty completion list after
      // textDocument/didSave until the next textDocument/didChange. Clearing
      // syncedTextRef alone made the NEXT feature query pay a didChange IPC
      // round trip first; with typing faster than that round trip every query
      // was dropped as stale before lspCompletion could be sent. Instead, send
      // the recovery didChange right here in the save path (save is low
      // frequency) so the buffer is marked synced again and the next
      // completion/signature request takes the fast already-synced path.
      delete syncedTextRef.current[file.key];
      if (status.active) {
        documentActiveRef.current[file.key] = true;
      } else {
        documentActiveRef.current[file.key] = false;
      }
      updateLspFiles((current) => {
        const existing = current[file.key] ?? emptyLspFileState();
        return {
          ...current,
          [file.key]: {
            ...existing,
            status,
            syncing: false,
            syncedText: status.active ? text : null,
            error: null,
            errorGeneration: nextErrorGeneration(existing, status.error, null),
          },
        };
      });
      scheduleDiagnostics(file.key);
      const latest = openFilesRef.current[file.key];
      if (latest && status.active) {
        // Unconditional: restores jdtls out of the didSave empty state. Same
        // text → no-op full didChange; mid-save edits → syncs the newer buffer.
        await syncDocument(latest, "change");
      } else if (latest && latest.text !== text) {
        await syncDocument(latest, "change");
      }
    } catch (error) {
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? emptyLspFileState()),
          syncing: false,
          error: errorMessage(error),
          errorGeneration: nextErrorGeneration(
            current[file.key] ?? emptyLspFileState(),
            null,
            errorMessage(error),
          ),
        },
      }));
    }
  }, [
    descriptorForFile,
    isDocumentSynced,
    openFilesRef,
    scheduleDiagnostics,
    syncDocument,
    updateLspFiles,
    waitForDocumentSyncQueue,
  ]);

  const forgetDocument = useCallback((key: string) => {
    delete versionRef.current[key];
    delete syncedTextRef.current[key];
    delete incrementalSyncRef.current[key];
    delete documentActiveRef.current[key];
    delete diagnosticsRequestSequenceRef.current[key];
    const timer = diagnosticsTimersRef.current[key];
    if (timer) window.clearTimeout(timer);
    delete diagnosticsTimersRef.current[key];
  }, []);

  const closeDocumentAndWait = useCallback(async (file: OpenFileState) => {
    const queue = syncQueuesRef.current[file.key];
    if (queue) {
      queue.closed = true;
      queue.pending = null;
      delete syncQueuesRef.current[file.key];
      queue.waiters.splice(0).forEach((resolve) => resolve());
    }
    // Never opened by us (library source) → nothing to close on the server.
    const descriptor = file.library ? null : descriptorForFile(file);
    if (descriptor) await lspCloseDocument(descriptor);
    forgetDocument(file.key);
  }, [descriptorForFile, forgetDocument]);

  const closeDocument = useCallback((file: OpenFileState) => {
    void closeDocumentAndWait(file).catch((error) => onError(errorMessage(error)));
  }, [closeDocumentAndWait, onError]);

  const sessionGeneration = useCallback(() => sessionGenerationRef.current, []);

  return {
    serverStatuses,
    commandPrefs,
    customCommands,
    refreshServerStatuses,
    updateCommandPref,
    updateCustomCommand,
    descriptorForFile,
    descriptorForPath,
    isDocumentSynced,
    documentVersion,
    sessionGeneration,
    syncDocument,
    waitForSyncQueue: waitForDocumentSyncQueue,
    saveDocument,
    closeDocument,
    closeDocumentAndWait,
    forgetDocument,
    updateStatus,
    restartServers: restartWorkspaceServers,
  };
}
