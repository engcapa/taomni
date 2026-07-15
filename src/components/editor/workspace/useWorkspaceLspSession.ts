import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  lspChangeDocument,
  lspCloseDocument,
  lspDetectServers,
  lspGetDiagnostics,
  lspOpenDocument,
  lspSaveDocument,
  lspStopWorkspace,
  type LspDocumentDescriptor,
  type LspDocumentStatus,
  type LspServerStatus,
} from "../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { buildIncrementalContentChange } from "./lspTextEdits";
import {
  CUSTOM_LSP_COMMAND_ID,
  customServerCommandFromConfig,
  emptyLspFileState,
  errorMessage,
  lspPresetIdForPath,
  readLspCommandPrefs,
  readLspCustomCommands,
  subscribeLspServerPrefs,
  writeLspCommandPrefs,
  writeLspCustomCommands,
  type LspCustomCommandConfig,
  type LspFileState,
  type OpenFileState,
} from "./codeWorkspaceModel";

type LspFilesUpdater = (
  updater: Record<string, LspFileState>
    | ((current: Record<string, LspFileState>) => Record<string, LspFileState>),
) => void;

interface UseWorkspaceLspSessionOptions {
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  openFilesRef: MutableRefObject<Record<string, OpenFileState>>;
  updateLspFiles: LspFilesUpdater;
  onError: (message: string) => void;
}

interface PendingDocumentSync {
  file: OpenFileState;
  mode: "open" | "change";
}

interface DocumentSyncQueue {
  closed: boolean;
  pending: PendingDocumentSync | null;
}

/**
 * LSP feature responses all carry a document status.  Most responses for an
 * already-open document repeat that exact status, and publishing a new store
 * map for each one makes the whole workspace chrome render again.  Keep the
 * comparison local and cheap (the capability summary is small) so feature
 * requests that do not change observable state are true no-ops.
 */
function sameDocumentStatus(left: LspDocumentStatus, right: LspDocumentStatus): boolean {
  return left === right || (
    left.path === right.path
    && left.uri === right.uri
    && left.presetId === right.presetId
    && left.languageId === right.languageId
    && left.displayName === right.displayName
    && left.available === right.available
    && left.active === right.active
    && left.selectedCommandId === right.selectedCommandId
    && left.selectedCommand === right.selectedCommand
    && left.installHint === right.installHint
    && left.error === right.error
    && JSON.stringify(left.capabilities ?? null) === JSON.stringify(right.capabilities ?? null)
  );
}

export interface WorkspaceLspSessionController {
  serverStatuses: LspServerStatus[];
  commandPrefs: Record<string, string>;
  customCommands: Record<string, LspCustomCommandConfig>;
  refreshServerStatuses: () => Promise<void>;
  updateCommandPref: (presetId: string, commandId: string) => void;
  updateCustomCommand: (presetId: string, patch: Partial<LspCustomCommandConfig>) => void;
  descriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  syncDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  saveDocument: (file: OpenFileState, text: string) => Promise<void>;
  closeDocument: (file: OpenFileState) => void;
  forgetDocument: (key: string) => void;
  updateStatus: (file: OpenFileState, status: LspDocumentStatus) => void;
}

/** Centralizes the open/change/save/close lifecycle for one workspace instance. */
export function useWorkspaceLspSession({
  workspaceInstanceId,
  roots,
  openFilesRef,
  updateLspFiles,
  onError,
}: UseWorkspaceLspSessionOptions): WorkspaceLspSessionController {
  const [serverStatuses, setServerStatuses] = useState<LspServerStatus[]>([]);
  const [commandPrefs, setCommandPrefs] = useState<Record<string, string>>(() => readLspCommandPrefs());
  const [customCommands, setCustomCommands] = useState<Record<string, LspCustomCommandConfig>>(
    () => readLspCustomCommands(),
  );
  const rootsRef = useRef(roots);
  const versionRef = useRef<Record<string, number>>({});
  const syncedTextRef = useRef<Record<string, string>>({});
  const incrementalSyncRef = useRef<Record<string, boolean>>({});
  const diagnosticsTimersRef = useRef<Record<string, number>>({});
  const syncQueuesRef = useRef<Record<string, DocumentSyncQueue>>({});
  const mountedRef = useRef(true);

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
      Object.values(diagnosticsTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      diagnosticsTimersRef.current = {};
    };
  }, []);

  useEffect(() => () => {
    void lspStopWorkspace(workspaceInstanceId);
  }, [workspaceInstanceId]);

  const refreshServerStatuses = useCallback(async () => {
    try {
      const statuses = await lspDetectServers();
      if (mountedRef.current) setServerStatuses(statuses);
    } catch (error) {
      if (mountedRef.current) onError(errorMessage(error));
    }
  }, [onError]);

  useEffect(() => {
    void refreshServerStatuses();
  }, [refreshServerStatuses]);

  // Settings panel is the primary editor for LSP server prefs; keep live
  // workspace sessions in sync without remounting the tab.
  useEffect(() => subscribeLspServerPrefs(() => {
    if (!mountedRef.current) return;
    setCommandPrefs(readLspCommandPrefs());
    setCustomCommands(readLspCustomCommands());
    syncedTextRef.current = {};
    incrementalSyncRef.current = {};
    updateLspFiles((current) => Object.fromEntries(
      Object.entries(current).map(([key, state]) => [key, { ...state, syncedText: null }]),
    ));
    void refreshServerStatuses();
  }), [refreshServerStatuses, updateLspFiles]);

  const invalidateSyncedText = useCallback(() => {
    syncedTextRef.current = {};
    incrementalSyncRef.current = {};
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

  const descriptorForFile = useCallback((file: OpenFileState): LspDocumentDescriptor | null => {
    const presetId = lspPresetIdForPath(file.languagePath);
    const commandPref = presetId ? commandPrefs[presetId] ?? null : null;
    const serverCommandId = commandPref && commandPref !== CUSTOM_LSP_COMMAND_ID ? commandPref : null;
    const customServerCommand = presetId && commandPref === CUSTOM_LSP_COMMAND_ID
      ? customServerCommandFromConfig(customCommands[presetId])
      : null;
    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      const root = rootsRef.current.find((candidate) => candidate.id === rootId);
      if (!root) return null;
      return {
        workspaceId: workspaceInstanceId,
        rootPath: root.path,
        filePath: file.ref.path,
        serverCommandId,
        customServerCommand,
      };
    }
    return {
      workspaceId: workspaceInstanceId,
      rootPath: null,
      filePath: file.ref.path,
      serverCommandId,
      customServerCommand,
    };
  }, [commandPrefs, customCommands, workspaceInstanceId]);

  const updateStatus = useCallback((file: OpenFileState, status: LspDocumentStatus) => {
    if (!mountedRef.current) return;
    updateLspFiles((current) => {
      const existing = current[file.key] ?? emptyLspFileState();
      if (existing.status && sameDocumentStatus(existing.status, status)
        && !existing.syncing && existing.error === null) {
        return current;
      }
      return {
        ...current,
        [file.key]: {
          ...existing,
          status,
          syncing: false,
          error: null,
        },
      };
    });
  }, [updateLspFiles]);

  const refreshDiagnostics = useCallback(async (file: OpenFileState) => {
    const descriptor = descriptorForFile(file);
    if (!descriptor) return;
    try {
      const result = await lspGetDiagnostics(descriptor);
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? emptyLspFileState()),
          status: result.status,
          diagnostics: result.diagnostics,
          syncing: false,
          error: null,
        },
      }));
    } catch (error) {
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? emptyLspFileState()),
          syncing: false,
          error: errorMessage(error),
        },
      }));
    }
  }, [descriptorForFile, openFilesRef, updateLspFiles]);

  const scheduleDiagnostics = useCallback((key: string) => {
    const existing = diagnosticsTimersRef.current[key];
    if (existing) window.clearTimeout(existing);
    diagnosticsTimersRef.current[key] = window.setTimeout(() => {
      delete diagnosticsTimersRef.current[key];
      const latest = openFilesRef.current[key];
      if (latest) void refreshDiagnostics(latest);
    }, 500);
  }, [openFilesRef, refreshDiagnostics]);

  const syncDocument = useCallback(async (file: OpenFileState, mode: "open" | "change") => {
    if (file.loading) return;
    const running = syncQueuesRef.current[file.key];
    if (running) {
      running.pending = { file, mode };
      return;
    }

    const queue: DocumentSyncQueue = { closed: false, pending: null };
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
        updateLspFiles((current) => ({
          ...current,
          [currentSync.file.key]: {
            ...(current[currentSync.file.key] ?? emptyLspFileState()),
            syncing: true,
            error: null,
          },
        }));
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
          }
          updateLspFiles((current) => ({
            ...current,
            [currentSync.file.key]: {
              ...(current[currentSync.file.key] ?? emptyLspFileState()),
              status,
              diagnostics: current[currentSync.file.key]?.diagnostics ?? [],
              syncing: queue.pending !== null,
              syncedText: currentSync.file.text,
              error: null,
            },
          }));
          scheduleDiagnostics(currentSync.file.key);
        } catch (error) {
          if (!mountedRef.current || queue.closed || !openFilesRef.current[currentSync.file.key]) break;
          updateLspFiles((current) => ({
            ...current,
            [currentSync.file.key]: {
              ...(current[currentSync.file.key] ?? emptyLspFileState()),
              syncing: queue.pending !== null,
              error: errorMessage(error),
            },
          }));
        }
        next = queue.pending;
        queue.pending = null;
        if (next && active) next.mode = "change";
      }
    } finally {
      if (syncQueuesRef.current[file.key] === queue) delete syncQueuesRef.current[file.key];
    }
  }, [descriptorForFile, openFilesRef, scheduleDiagnostics, updateLspFiles]);

  const saveDocument = useCallback(async (file: OpenFileState, text: string) => {
    const descriptor = descriptorForFile(file);
    if (!descriptor) return;
    try {
      const status = await lspSaveDocument(descriptor, text, versionRef.current[file.key] ?? 0);
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? emptyLspFileState()),
          status,
          syncing: false,
          syncedText: text,
          error: null,
        },
      }));
      scheduleDiagnostics(file.key);
    } catch (error) {
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? emptyLspFileState()),
          syncing: false,
          syncedText: text,
          error: errorMessage(error),
        },
      }));
    }
  }, [descriptorForFile, openFilesRef, scheduleDiagnostics, updateLspFiles]);

  const forgetDocument = useCallback((key: string) => {
    delete versionRef.current[key];
    delete syncedTextRef.current[key];
    delete incrementalSyncRef.current[key];
    const timer = diagnosticsTimersRef.current[key];
    if (timer) window.clearTimeout(timer);
    delete diagnosticsTimersRef.current[key];
  }, []);

  const closeDocument = useCallback((file: OpenFileState) => {
    const queue = syncQueuesRef.current[file.key];
    if (queue) {
      queue.closed = true;
      queue.pending = null;
      delete syncQueuesRef.current[file.key];
    }
    const descriptor = descriptorForFile(file);
    if (descriptor) void lspCloseDocument(descriptor);
    forgetDocument(file.key);
  }, [descriptorForFile, forgetDocument]);

  return {
    serverStatuses,
    commandPrefs,
    customCommands,
    refreshServerStatuses,
    updateCommandPref,
    updateCustomCommand,
    descriptorForFile,
    syncDocument,
    saveDocument,
    closeDocument,
    forgetDocument,
    updateStatus,
  };
}
