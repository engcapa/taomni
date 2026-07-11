import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  lspChangeDocument,
  lspCloseDocument,
  lspDetectServers,
  lspGetDiagnostics,
  lspOpenDocument,
  lspSaveDocument,
  type LspDocumentDescriptor,
  type LspDocumentStatus,
  type LspServerStatus,
} from "../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../types";
import type { LspCustomCommandConfig } from "./FileTreePane";
import {
  CUSTOM_LSP_COMMAND_ID,
  customServerCommandFromConfig,
  emptyLspFileState,
  errorMessage,
  lspPresetIdForPath,
  readLspCommandPrefs,
  readLspCustomCommands,
  writeLspCommandPrefs,
  writeLspCustomCommands,
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
  const diagnosticsTimersRef = useRef<Record<string, number>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      Object.values(diagnosticsTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      diagnosticsTimersRef.current = {};
    };
  }, []);

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

  const invalidateSyncedText = useCallback(() => {
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
    updateLspFiles((current) => ({
      ...current,
      [file.key]: {
        ...(current[file.key] ?? emptyLspFileState()),
        status,
        syncing: false,
        error: null,
      },
    }));
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
    const descriptor = descriptorForFile(file);
    if (!descriptor) return;
    const version = (versionRef.current[file.key] ?? 0) + 1;
    versionRef.current[file.key] = version;
    updateLspFiles((current) => ({
      ...current,
      [file.key]: {
        ...(current[file.key] ?? emptyLspFileState()),
        syncing: true,
        error: null,
      },
    }));
    try {
      const status = mode === "open"
        ? await lspOpenDocument(descriptor, file.text, version)
        : await lspChangeDocument(descriptor, file.text, version);
      if (!mountedRef.current || !openFilesRef.current[file.key]) return;
      updateLspFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? emptyLspFileState()),
          status,
          diagnostics: current[file.key]?.diagnostics ?? [],
          syncing: false,
          syncedText: file.text,
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
          error: errorMessage(error),
        },
      }));
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
    const timer = diagnosticsTimersRef.current[key];
    if (timer) window.clearTimeout(timer);
    delete diagnosticsTimersRef.current[key];
  }, []);

  const closeDocument = useCallback((file: OpenFileState) => {
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
