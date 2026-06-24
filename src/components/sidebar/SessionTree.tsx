import { useEffect, useMemo, useRef, useState } from "react";
import {
  Terminal as TerminalIcon,
  Monitor,
  Folder,
  Wifi,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Play,
  Edit3,
  Copy,
  Trash2,
  Plus,
  FolderPlus,
  Upload,
  Download,
  FileText,
  Share2,
  Star,
  Database,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { FolderNameDialog } from "./FolderNameDialog";
import type { SessionConfig, SessionGroup } from "../../lib/ipc";
import {
  importExternalBashSessions,
  importPuttySessions,
  importWslSessions,
  isVaultLockedError,
  getHomeDir,
  keychainLookupBatch,
  readDbeaverCredentialsForDataSources,
  readFileBytes,
  readPlistSessionFile,
  scanLocalSessionFiles,
  secureCrtDecryptPasswords,
  selectFilePath,
  tabbyDecryptVault,
  vaultPut,
  type KeychainHit,
  type KeychainQuery,
  type SecureCrtPasswordFailure,
  type SecureCrtPasswordHit,
  type TabbySecret,
} from "../../lib/ipc";
import {
  startCustomDrag,
  useCustomDropTarget,
  type CustomDragData,
} from "../../lib/customDnD";
import {
  parseCsvSessions,
  parseDbeaverSessions,
  parseExceedSessions,
  parseItermDynamicProfiles,
  parseMobaXtermSessions,
  parseTaomniSessions,
  parseSecureCrtSessions,
  parseTabbySessions,
  parseTerminalAppProfiles,
  parseWindTermSessions,
  parseXmlConnectionSessions,
  parseXshellSessions,
  parseXshellZipSessions,
  parseXshellFile,
  parseZeroOmegaProxies,
  createSessionImportResult,
  serializeCsvSessions,
  serializeMobaXtermSessions,
  serializeTaomniSessions,
  type SessionExportResult,
  type SessionImportOptions,
  type SessionImportResult,
} from "../../lib/sessionImportExport";
import { parseSessionOptions, sessionTypeLabel } from "../../lib/terminalProfile";
import { parseOpenSshConfig } from "../../lib/quickConnect";
import { openBinaryFile, openTextFile, openTextFileWithName, downloadTextFile } from "../../lib/fileHelpers";
import { serializeHtmlSessions } from "../../lib/sessionExportHtml";
import {
  SESSION_ROOT_LABEL,
  ancestorGroupPaths,
  collectFolderPaths,
  folderOptionLabel,
  groupPathContains,
  leafGroupName,
  normalizeGroupPath,
  parentGroupPath,
  toStoredGroupPath,
} from "../../lib/sessionPaths";
import { SessionImportPreview } from "../session/SessionImportPreview";
import { ExternalVaultUnlockDialog } from "../session/ExternalVaultUnlockDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { useT } from "../../lib/i18n";
import { ensureVaultReady } from "../../lib/vaultGate";

const SESSION_DRAG_MIME = "taomni/session";

interface SessionDragPayload {
  sessionId: string;
}

interface SessionTreeProps {
  onNewSession?: (groupPath?: string | null) => void;
  onConnectSession?: (session: SessionConfig) => void;
  onEditSession?: (session: SessionConfig) => void;
}

interface FolderNode {
  name: string;
  path: string | null;
  folders: FolderNode[];
  sessions: SessionConfig[];
}

type TextSessionParser = (text: string, options?: SessionImportOptions) => SessionImportResult;

export function SessionTree({ onNewSession, onConnectSession, onEditSession }: SessionTreeProps) {
  const t = useT();
  const {
    sessions,
    groups,
    searchQuery,
    selectedSessionIds,
    loadSessions,
    removeSessions,
    duplicateSessions,
    moveSessionToGroup,
    moveSessionsToGroup,
    createFolderPath,
    renameFolderPath,
    deleteFolderPath,
    importSessions,
    setSelectedSession,
    toggleSessionSelection,
    loading,
  } = useSessionStore();
  const { setStatusMessage } = useAppStore();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ root: true });
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<
    | { mode: "create"; parentPath: string | null }
    | { mode: "rename"; parentPath: string | null; folderPath: string; initialName: string }
    | null
  >(null);
  const [pendingImport, setPendingImport] = useState<{
    result: SessionImportResult;
    folderPath: string | null;
    source: string;
  } | null>(null);
  const [externalVaultPrompt, setExternalVaultPrompt] = useState<{
    toolName: string;
    title?: string;
    description: string;
    passwordLabel?: string;
    errorMessage: string | null;
    onSubmit: (password: string) => Promise<void>;
    onSkip: () => void;
  } | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title?: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const ctx = useContextMenu();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const filteredSessions = useMemo(
    () => filterSessions(sessions, searchQuery),
    [sessions, searchQuery],
  );
  const tree = useMemo(
    () => buildSessionTree(filteredSessions, searchQuery ? [] : groups),
    [filteredSessions, groups, searchQuery],
  );
  const folderPaths = useMemo(
    () => collectFolderPaths(sessions, groups),
    [sessions, groups],
  );
  const effectiveSelectedSessionIds = useMemo(
    () => new Set(selectedSessionIds),
    [selectedSessionIds],
  );

  const toggle = (key: string) =>
    setExpanded((e) => ({ ...e, [key]: !e[key] }));

  const expandPath = (path: string | null | undefined) => {
    setExpanded((state) => {
      const next: Record<string, boolean> = { ...state, root: true };
      for (const ancestor of ancestorGroupPaths(path)) {
        next[folderKey(ancestor)] = true;
      }
      return next;
    });
  };

  const handleDrop = (groupPath: string | null, sessionId: string) => {
    setDragOverGroup(null);
    if (!sessionId) return;
    void moveSessionToGroup(sessionId, groupPath);
    expandPath(groupPath);
  };

  const handleDragOver = (groupPath: string | null) => {
    setDragOverGroup(folderKey(groupPath));
  };

  const createFolder = (parentPath: string | null) => {
    setFolderDialog({ mode: "create", parentPath: normalizeGroupPath(parentPath) });
  };

  const handleCreateFolderSubmit = async (folderPath: string) => {
    const normalized = normalizeGroupPath(folderPath);
    if (!normalized) return;

    await createFolderPath(normalized);
    expandPath(normalized);
    setStatusMessage(t("sessionTree.folderCreated", { label: folderOptionLabel(normalized) }));
  };

  const renameFolder = (folderPath: string) => {
    const normalized = normalizeGroupPath(folderPath);
    if (!normalized) return;
    setFolderDialog({
      mode: "rename",
      parentPath: parentGroupPath(normalized),
      folderPath: normalized,
      initialName: leafGroupName(normalized),
    });
  };

  const handleRenameFolderSubmit = async (sourcePath: string, targetPath: string) => {
    const oldNormalized = normalizeGroupPath(sourcePath);
    const newNormalized = normalizeGroupPath(targetPath);
    if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) return;
    if (groupPathContains(oldNormalized, newNormalized)) {
      window.alert(t("sessionTree.folderCannotMoveInside"));
      return;
    }

    await renameFolderPath(oldNormalized, newNormalized);
    expandPath(newNormalized);
    setStatusMessage(t("sessionTree.folderRenamed", { label: folderOptionLabel(newNormalized) }));
  };

  const handleFolderDialogSubmit = async (folderPath: string) => {
    const dialog = folderDialog;
    setFolderDialog(null);
    if (!dialog) return;
    if (dialog.mode === "create") {
      await handleCreateFolderSubmit(folderPath);
    } else {
      await handleRenameFolderSubmit(dialog.folderPath, folderPath);
    }
  };

  const deleteFolder = (folderPath: string) => {
    const affected = sessionsInFolder(sessions, folderPath);
    const suffix = affected.length > 0
      ? t("sessionTree.deleteFolderSuffix", { count: affected.length, plural: affected.length === 1 ? "" : "s" })
      : "";
    setConfirmPrompt({
      title: t("sessionTree.deleteFolderTitle"),
      message: t("sessionTree.deleteFolderMessage", { label: folderOptionLabel(folderPath), suffix }),
      confirmLabel: t("sessionTree.deleteAction"),
      danger: true,
      onConfirm: () => {
        setConfirmPrompt(null);
        void (async () => {
          await deleteFolderPath(folderPath);
          setStatusMessage(t("sessionTree.folderDeleted", { label: folderOptionLabel(folderPath) }));
        })();
      },
    });
  };

  const exportFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeTaomniSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("Taomni", result, folderSessions.length, label);
  };

  const exportMobaFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeMobaXtermSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("MobaXterm", result, folderSessions.length - result.skipped, label);
  };

  const exportCsvFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeCsvSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("CSV", result, folderSessions.length - result.skipped, label);
  };

  const generateHtml = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeHtmlSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("HTML", result, folderSessions.length, label);
  };

  const importJson = (folderPath: string | null) => {
    openTextFile(".json,.taomni-sessions.json,.newmob-sessions.json,application/json").then((text) => {
      if (!text) return;
      const result = parseTaomniSessions(text, { targetFolder: folderPath, existingSessions: sessions });
      queueImportPreview(result, folderPath, "Taomni");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importMoba = (folderPath: string | null) => {
    openBinaryFile(".mxtsessions,.moba,text/plain,application/octet-stream").then(async (bytes) => {
      if (!bytes) return;
      const homeDir = await getHomeDir().catch(() => null);
      const result = parseMobaXtermSessions(bytes, { targetFolder: folderPath, existingSessions: sessions, homeDir });
      queueImportPreview(result, folderPath, "MobaXterm");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importCsv = (folderPath: string | null) => {
    openTextFile(".csv,text/csv").then((text) => {
      if (!text) return;
      const result = parseCsvSessions(text, { targetFolder: folderPath, existingSessions: sessions });
      queueImportPreview(result, folderPath, "CSV");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const queueImportPreview = (
    result: SessionImportResult,
    folderPath: string | null,
    source: string,
  ) => {
    if (result.externalSecretsTool === "tabby") {
      void enrichTabbyResult(result)
        .then((enriched) => setPendingImport({ result: enriched, folderPath, source }))
        .catch((error) => {
          window.alert(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    if (result.externalSecretsTool === "securecrt") {
      void enrichSecureCrtResult(result)
        .then((enriched) => setPendingImport({ result: enriched, folderPath, source }))
        .catch((error) => {
          window.alert(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    setPendingImport({ result, folderPath, source });
  };

  /**
   * Recover passwords from third-party tools' OS keychain entries and (when
   * the user enters a master password) their encrypted vault. Returns a new
   * result with extra entries folded into `secrets`. Tool-specific copy comes
   * from `result.externalVault`.
   *
   * For Tabby:
   *   - vault unlock prompt opens if `externalVault.tool === "Tabby"`
   *   - regardless of vault path, the OS keychain is queried for every
   *     password-auth session under `ssh@<host>[:<port>]` / `<user>`
   */
  const enrichTabbyResult = async (
    result: SessionImportResult,
  ): Promise<SessionImportResult> => {
    if (result.externalSecretsTool !== "tabby") return result;

    let vaultSecrets: TabbySecret[] = [];
    if (result.externalVault) {
      vaultSecrets = await promptTabbyVaultUnlock(
        result.externalVault.rawText,
        result.externalVault.description,
      );
    }

    const keychainHits = await lookupTabbyKeychain(result.sessions, vaultSecrets);

    return mergeTabbySecrets(result, vaultSecrets, keychainHits);
  };

  const promptTabbyVaultUnlock = (rawText: string, description: string): Promise<TabbySecret[]> =>
    new Promise((resolve) => {
      const close = (secrets: TabbySecret[]) => {
        setExternalVaultPrompt(null);
        resolve(secrets);
      };
      let attempts = 0;
      setExternalVaultPrompt({
        toolName: "Tabby",
        description,
        errorMessage: null,
        onSkip: () => close([]),
        onSubmit: async (password) => {
          attempts += 1;
          try {
            const response = await tabbyDecryptVault(rawText, password);
            close(response.secrets);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const friendly = msg.includes("tabby_vault_bad_password")
              ? `Incorrect Tabby master password (attempt ${attempts}).`
              : msg.includes("tabby_vault_missing")
                ? "No vault block found in this Tabby config."
                : msg;
            // Throwing keeps the dialog open and surfaces the error inline.
            throw new Error(friendly);
          }
        },
      });
    });

  const lookupTabbyKeychain = async (
    importedSessions: readonly SessionConfig[],
    vaultSecrets: readonly TabbySecret[],
  ): Promise<KeychainHit[]> => {
    const queries: KeychainQuery[] = [];
    const seen = new Set<string>();
    const addQuery = (service: string, account: string) => {
      const key = `${service} ${account}`;
      if (seen.has(key)) return;
      seen.add(key);
      queries.push({ service, account });
    };

    for (const session of importedSessions) {
      if (session.auth_method !== "Password") continue;
      const account = session.username?.trim();
      if (!account) continue;
      const host = session.host.trim();
      if (!host) continue;
      addQuery(`ssh@${host}:${session.port}`, account);
      addQuery(`ssh@${host}`, account);
    }

    for (const secret of vaultSecrets) {
      if (secret.kind === "key-passphrase" && secret.id) {
        addQuery(`ssh-private-key:${secret.id}`, "user");
      }
    }

    if (queries.length === 0) return [];
    try {
      return await keychainLookupBatch(queries);
    } catch (error) {
      // Don't fail the whole import on a missing keyring daemon; degrade
      // gracefully and let the user re-enter passwords manually.
      const msg = error instanceof Error ? error.message : String(error);
      console.warn("Keychain lookup failed:", msg);
      return [];
    }
  };

  const mergeTabbySecrets = (
    result: SessionImportResult,
    vaultSecrets: readonly TabbySecret[],
    keychainHits: readonly KeychainHit[],
  ): SessionImportResult => {
    const newSecrets = [...result.secrets];
    const warnings = [...result.warnings];
    const matched = new Set<string>(); // session ids that now have a recovered password
    let recoveredFromVault = 0;
    let recoveredFromKeychain = 0;
    const standalonePassphrases: TabbySecret[] = [];

    for (const session of result.sessions) {
      if (session.auth_method !== "Password") continue;
      // Already had a plaintext password from config.yaml — skip.
      if (newSecrets.some((s) => s.sessionId === session.id && s.kind === "password")) continue;

      const sessionUser = session.username?.trim();
      if (!sessionUser) continue;

      // Try vault first (more authoritative).
      const vaultMatch = vaultSecrets.find((s) =>
        s.kind === "password" &&
        s.host.toLowerCase() === session.host.toLowerCase() &&
        (s.user ?? "").toLowerCase() === sessionUser.toLowerCase() &&
        (s.port == null || s.port === session.port),
      );
      if (vaultMatch && vaultMatch.kind === "password") {
        newSecrets.push({
          sessionId: session.id,
          kind: "password",
          label: `${sessionUser}@${session.host}:${session.port}`,
          value: vaultMatch.value,
          attachment: "session",
        });
        matched.add(session.id);
        recoveredFromVault += 1;
        continue;
      }

      // Fall back to keychain hits.
      const hostKey = session.host.toLowerCase();
      const candidates = [
        `ssh@${hostKey}:${session.port}`,
        `ssh@${hostKey}`,
      ];
      const hit = keychainHits.find((h) =>
        candidates.includes(h.service.toLowerCase()) &&
        h.account.toLowerCase() === sessionUser.toLowerCase() &&
        h.found && h.value,
      );
      if (hit?.value) {
        newSecrets.push({
          sessionId: session.id,
          kind: "password",
          label: `${sessionUser}@${session.host}:${session.port}`,
          value: hit.value,
          attachment: "session",
        });
        matched.add(session.id);
        recoveredFromKeychain += 1;
      }
    }

    for (const secret of vaultSecrets) {
      if (secret.kind === "key-passphrase") standalonePassphrases.push(secret);
    }

    for (const passphrase of standalonePassphrases) {
      if (passphrase.kind !== "key-passphrase") continue;
      const shortId = passphrase.id.slice(0, 8);
      newSecrets.push({
        sessionId: "", // standalone — no session
        kind: "key-passphrase",
        label: t("sessionTree.tabbyPrivateKeyLabel", { id: shortId }),
        value: passphrase.value,
        attachment: "standalone",
      });
    }

    if (recoveredFromVault > 0 || recoveredFromKeychain > 0) {
      warnings.push(
        t("sessionTree.recoveredPasswords", {
          count: recoveredFromVault + recoveredFromKeychain,
          vault: recoveredFromVault,
          keychain: recoveredFromKeychain,
        }),
      );
    }
    if (standalonePassphrases.length > 0) {
      warnings.push(
        t("sessionTree.standaloneTabbyPassphrases", { count: standalonePassphrases.length }),
      );
    }

    return {
      ...result,
      secrets: newSecrets,
      warnings,
      // Clear the prompt — the unlock pass has happened.
      externalVault: undefined,
      externalSecretsTool: undefined,
    };
  };

  const enrichSecureCrtResult = async (
    result: SessionImportResult,
  ): Promise<SessionImportResult> => {
    if (result.externalSecretsTool !== "securecrt") return result;
    const pendingPasswords = result.secureCrtPasswords ?? [];
    if (pendingPasswords.length === 0) {
      return { ...result, externalSecretsTool: undefined };
    }

    const firstPass = await secureCrtDecryptPasswords(
      pendingPasswords.map(({ sessionId, encrypted }) => ({ sessionId, encrypted })),
      "",
    );

    let hits: SecureCrtPasswordHit[] = [...firstPass.secrets];
    let failures: SecureCrtPasswordFailure[] = [...firstPass.failures];
    const needsPassphraseIds = new Set(
      failures.filter((failure) => failure.needsPassphrase).map((failure) => failure.sessionId),
    );

    if (needsPassphraseIds.size > 0) {
      const retryPasswords = pendingPasswords.filter((password) => needsPassphraseIds.has(password.sessionId));
      const retry = await promptSecureCrtPassphraseUnlock(retryPasswords);
      hits = [...hits, ...retry.secrets];
      const retried = new Set(retryPasswords.map((password) => password.sessionId));
      failures = [
        ...failures.filter((failure) => !retried.has(failure.sessionId)),
        ...retry.failures,
      ];
    }

    return mergeSecureCrtSecrets(result, hits, failures);
  };

  const promptSecureCrtPassphraseUnlock = (
    passwords: NonNullable<SessionImportResult["secureCrtPasswords"]>,
  ): Promise<{ secrets: SecureCrtPasswordHit[]; failures: SecureCrtPasswordFailure[] }> =>
    new Promise((resolve) => {
      const close = (response: { secrets: SecureCrtPasswordHit[]; failures: SecureCrtPasswordFailure[] }) => {
        setExternalVaultPrompt(null);
        resolve(response);
      };
      let attempts = 0;
      setExternalVaultPrompt({
        toolName: "SecureCRT",
        title: t("sessionTree.secureCrtPassphraseTitle"),
        description: t("sessionTree.secureCrtPassphraseDescription"),
        passwordLabel: t("sessionTree.secureCrtPassphraseLabel"),
        errorMessage: null,
        onSkip: () => close({
          secrets: [],
          failures: passwords.map((password) => ({
            sessionId: password.sessionId,
            error: "securecrt_password_passphrase_skipped",
            needsPassphrase: false,
          })),
        }),
        onSubmit: async (passphrase) => {
          attempts += 1;
          const response = await secureCrtDecryptPasswords(
            passwords.map(({ sessionId, encrypted }) => ({ sessionId, encrypted })),
            passphrase,
          );
          const stillNeedsPassphrase = response.failures.some((failure) => failure.needsPassphrase);
          if (stillNeedsPassphrase && response.secrets.length === 0) {
            throw new Error(t("sessionTree.secureCrtIncorrectPassphrase", { attempt: attempts }));
          }
          close(response);
        },
      });
    });

  const mergeSecureCrtSecrets = (
    result: SessionImportResult,
    hits: readonly SecureCrtPasswordHit[],
    failures: readonly SecureCrtPasswordFailure[],
  ): SessionImportResult => {
    const pendingById = new Map((result.secureCrtPasswords ?? []).map((password) => [password.sessionId, password]));
    const newSecrets = [...result.secrets];
    const warnings = [...result.warnings];
    const seenSecret = new Set(newSecrets.filter((secret) => secret.kind === "password").map((secret) => secret.sessionId));
    let recovered = 0;

    for (const hit of hits) {
      const pending = pendingById.get(hit.sessionId);
      if (!pending || seenSecret.has(hit.sessionId)) continue;
      newSecrets.push({
        sessionId: hit.sessionId,
        kind: "password",
        label: pending.label,
        value: hit.value,
        attachment: "session",
      });
      seenSecret.add(hit.sessionId);
      recovered += 1;
    }

    const unrecovered = failures.filter((failure) => pendingById.has(failure.sessionId)).length;
    if (recovered > 0) {
      warnings.push(t("sessionTree.secureCrtRecoveredPasswords", { count: recovered }));
    }
    if (unrecovered > 0) {
      warnings.push(t("sessionTree.secureCrtUnrecoveredPasswords", { count: unrecovered }));
    }

    return {
      ...result,
      secrets: newSecrets,
      warnings: [...new Set(warnings)],
      secureCrtPasswords: [],
      externalSecretsTool: undefined,
    };
  };


  const confirmPendingImport = async (selectedIds: ReadonlySet<string>) => {
    const pending = pendingImport;
    if (!pending) return;
    const filtered = filterImportResultBySelection(pending.result, selectedIds);
    await applyImportResult(filtered, pending.folderPath, pending.source, { alertWarnings: false });
    setPendingImport(null);
  };

  const filterImportResultBySelection = (
    result: SessionImportResult,
    selectedIds: ReadonlySet<string>,
  ): SessionImportResult => {
    const selectedSessions = result.sessions.filter((session) => selectedIds.has(session.id));
    if (selectedSessions.length === result.sessions.length) return result;
    const selectedSecrets = result.secrets.filter((secret) => {
      // Standalone secrets (e.g. Tabby private-key passphrases without an
      // attached session) live independently of the imported session list,
      // so user-level row selection does not affect them.
      const isStandalone = secret.attachment === "standalone" || !secret.sessionId;
      if (isStandalone) return true;
      return selectedIds.has(secret.sessionId);
    });
    const selectedSecureCrtPasswords = result.secureCrtPasswords?.filter((password) =>
      selectedIds.has(password.sessionId),
    );
    const droppedCount = result.sessions.length - selectedSessions.length;
    return {
      ...result,
      sessions: selectedSessions,
      secrets: selectedSecrets,
      secureCrtPasswords: selectedSecureCrtPasswords,
      skipped: result.skipped + droppedCount,
    };
  };

  const applyImportResult = async (
    result: SessionImportResult,
    folderPath: string | null,
    source: string,
    options: { alertWarnings?: boolean } = {},
  ) => {
    const prepared = await prepareImportResultForSave(result);
    if (prepared.sessions.length > 0) {
      await importSessions(prepared.sessions);
      expandPath(folderPath);
    }
    const hasNewWarnings = prepared.warnings.length > result.warnings.length;
    reportImportResult(source, prepared, folderPath, options.alertWarnings !== false || hasNewWarnings);
  };

  const prepareImportResultForSave = async (result: SessionImportResult): Promise<SessionImportResult> => {
    if (result.secrets.length === 0) return result;

    const vaultReady = await ensureVaultReady(t("vault.gateReasonSession"));
    if (!vaultReady) {
      return {
        ...result,
        warnings: [...new Set([
          ...result.warnings,
          t("sessionTree.skippedVaultUnlockCancelled", {
            count: result.secrets.length,
            plural: result.secrets.length === 1 ? "" : "s",
          }),
        ])],
        secrets: [],
      };
    }

    const sessionsById = new Map(result.sessions.map((session) => [session.id, { ...session }]));
    const warnings = [...result.warnings];
    let standaloneSaved = 0;
    let standaloneSkipped = 0;

    for (const secret of result.secrets) {
      const isStandalone = secret.attachment === "standalone" || !secret.sessionId;
      if (isStandalone) {
        const kind = secret.kind === "key-passphrase" ? "ssh-key-passphrase" : "ssh-password";
        try {
          await vaultPut(kind, secret.label, secret.value);
          standaloneSaved += 1;
        } catch (error) {
          standaloneSkipped += 1;
          if (isVaultLockedError(error)) {
            warnings.push(t("sessionTree.skippedStandalone"));
          }
        }
        continue;
      }

      const session = sessionsById.get(secret.sessionId);
      if (!session) continue;
      try {
        const saved = await vaultPut("ssh-password", secret.label, secret.value);
        const parsedOptions = parseSessionOptions(session.options_json);
        session.options_json = JSON.stringify({
          ...parsedOptions,
          passwordRef: saved.reference,
        });
      } catch (error) {
        const reason = isVaultLockedError(error)
          ? t("sessionTree.vaultLockedReason")
          : error instanceof Error ? error.message : String(error);
        warnings.push(t("sessionTree.skippedVaultLocked", { name: session.name, reason }));
      }
    }

    if (standaloneSaved > 0) {
      warnings.push(t("sessionTree.standaloneSaved", { count: standaloneSaved }));
    }
    if (standaloneSkipped > 0) {
      warnings.push(t("sessionTree.standaloneSkipped", { count: standaloneSkipped }));
    }

    return {
      ...result,
      sessions: result.sessions.map((session) => sessionsById.get(session.id) ?? session),
      warnings: [...new Set(warnings)],
      secrets: [],
    };
  };

  const reportImportResult = (
    source: string,
    result: SessionImportResult,
    folderPath: string | null,
    alertWarnings = true,
  ) => {
    const target = folderOptionLabel(folderPath);
    const count = result.sessions.length;
    const skipped = result.skipped ? t("sessionTree.skippedSuffix", { count: result.skipped }) : "";
    const warningSuffix = result.warnings.length ? t("sessionTree.warningsSuffix", { count: result.warnings.length, plural: result.warnings.length === 1 ? "" : "s" }) : "";
    setStatusMessage(t("sessionTree.importedCount", { count, source, plural: count === 1 ? "" : "s", target, skipped, warnings: warningSuffix }));
    if (alertWarnings) reportWarnings(result.warnings);
  };

  const reportExportResult = (
    format: string,
    result: SessionExportResult,
    count: number,
    label: string,
  ) => {
    const skipped = result.skipped ? t("sessionTree.skippedSuffix", { count: result.skipped }) : "";
    const warningSuffix = result.warnings.length ? t("sessionTree.warningsSuffix", { count: result.warnings.length, plural: result.warnings.length === 1 ? "" : "s" }) : "";
    setStatusMessage(t("sessionTree.exportedCount", { count, format, plural: count === 1 ? "" : "s", label, skipped, warnings: warningSuffix }));
    reportWarnings(result.warnings);
  };

  const reportWarnings = (warnings: string[]) => {
    if (warnings.length === 0) return;
    const shown = warnings.slice(0, 8);
    const more = warnings.length > shown.length ? t("sessionTree.warningsMore", { count: warnings.length - shown.length, plural: warnings.length - shown.length === 1 ? "" : "s" }) : "";
    window.alert(`${shown.join("\n")}${more}`);
  };

  const executeFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    connectSessions(folderSessions, t("sessionTree.fromFolder", { label: folderOptionLabel(folderPath) }));
  };

  const connectSessions = (targetSessions: readonly SessionConfig[], sourceLabel: string) => {
    const uniqueSessions = uniqueSessionsById(targetSessions);
    for (const session of uniqueSessions) {
      onConnectSession?.(session);
    }
    setStatusMessage(t("sessionTree.sessionsStarted", { count: uniqueSessions.length, plural: uniqueSessions.length === 1 ? "" : "s", source: sourceLabel }));
  };

  const selectSingleSession = (session: SessionConfig) => {
    setSelectedSession(session.id);
  };

  const handleSessionClick = (event: React.MouseEvent, session: SessionConfig) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggleSessionSelection(session.id);
      return;
    }
    selectSingleSession(session);
  };

  const mergeImportResults = (results: SessionImportResult[]): SessionImportResult =>
    createSessionImportResult(results.flatMap((result) => result.sessions), {
      existingSessions: sessions,
      warnings: results.flatMap((result) => result.warnings),
      skipped: results.reduce((sum, result) => sum + result.skipped, 0),
      secrets: results.flatMap((result) => result.secrets),
      secureCrtPasswords: results.flatMap((result) => result.secureCrtPasswords ?? []),
      externalVault: results.find((result) => result.externalVault)?.externalVault,
      externalSecretsTool: results.some((result) => result.externalSecretsTool === "securecrt")
        ? "securecrt"
        : results.find((result) => result.externalSecretsTool)?.externalSecretsTool,
    });

  const retargetImportedSessions = (
    imported: readonly SessionConfig[],
    folderPath: string | null,
    defaultSubfolder: string | null,
  ): SessionConfig[] => imported.map((session) => {
    const target = normalizeGroupPath(folderPath);
    const importedFolder = normalizeGroupPath(session.group_path) ?? normalizeGroupPath(defaultSubfolder);
    const groupPath = target && importedFolder
      ? `${target} / ${importedFolder}`
      : target ?? importedFolder;
    return { ...session, group_path: toStoredGroupPath(groupPath) };
  });

  const queueSessionListImport = (
    imported: readonly SessionConfig[],
    folderPath: string | null,
    source: string,
    defaultSubfolder: string | null,
  ) => {
    const result = createSessionImportResult(
      retargetImportedSessions(imported, folderPath, defaultSubfolder),
      { existingSessions: sessions },
    );
    queueImportPreview(result, folderPath, source);
  };

  const importBackendSessions = (
    folderPath: string | null,
    source: string,
    load: () => Promise<SessionConfig[]>,
    defaultSubfolder: string,
  ) => {
    load().then((imported) => {
      if (imported.length === 0) {
        setStatusMessage(t("sessionTree.noSessionsFound", { source }));
        return;
      }
      queueSessionListImport(imported, folderPath, source, defaultSubfolder);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importTextSessions = (
    folderPath: string | null,
    source: string,
    accept: string,
    parser: TextSessionParser,
    extraOptions?: () => Partial<SessionImportOptions>,
  ) => {
    openTextFileWithName(accept).then((file) => {
      if (!file) return;
      const result = parser(file.text, {
        targetFolder: folderPath,
        existingSessions: sessions,
        sourcePath: file.name,
        ...(extraOptions?.() ?? {}),
      });
      queueImportPreview(result, folderPath, source);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const dbeaverCredentialOptions = async (path: string): Promise<Partial<SessionImportOptions>> => {
    const credentials = await readDbeaverCredentialsForDataSources(path);
    return Object.keys(credentials).length > 0 ? { dbeaverCredentials: credentials } : {};
  };

  const importDbeaverFile = (folderPath: string | null) => {
    selectFilePath().then(async (path) => {
      if (!path) return;
      const text = new TextDecoder().decode(await readFileBytes(path));
      const result = parseDbeaverSessions(text, {
        targetFolder: folderPath,
        existingSessions: sessions,
        sourcePath: path,
        ...(await dbeaverCredentialOptions(path)),
      });
      queueImportPreview(result, folderPath, "DBeaver");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importScannedDbeaverSessions = (folderPath: string | null) => {
    scanLocalSessionFiles("dbeaver").then(async (files) => {
      if (files.length === 0) {
        setStatusMessage(t("sessionTree.noLocalConfigFound", { source: "DBeaver" }));
        return;
      }
      const results = await Promise.all(files.map(async (file) =>
        parseDbeaverSessions(file.text, {
          targetFolder: folderPath,
          existingSessions: sessions,
          sourcePath: file.relativePath || file.path,
          ...(await dbeaverCredentialOptions(file.path)),
        }),
      ));
      const result = mergeImportResults(results);
      queueImportPreview(result, folderPath, "DBeaver local config");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importXshellFile = (folderPath: string | null) => {
    openBinaryFile(".xsh,.xts,.zip,application/zip,application/x-zip-compressed,text/plain").then(async (bytes) => {
      if (!bytes) return;
      const result = await parseXshellFile(bytes, {
        targetFolder: folderPath,
        existingSessions: sessions,
      });
      queueImportPreview(result, folderPath, "Xshell");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importXshellZip = (folderPath: string | null) => {
    openBinaryFile(".zip,.xts,application/zip,application/x-zip-compressed").then(async (bytes) => {
      if (!bytes) return;
      const result = await parseXshellZipSessions(bytes, {
        targetFolder: folderPath,
        existingSessions: sessions,
      });
      queueImportPreview(result, folderPath, "Xshell ZIP");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importScannedTextSessions = (
    folderPath: string | null,
    scanKey: string,
    source: string,
    parser: TextSessionParser,
    extraOptions?: () => Partial<SessionImportOptions>,
  ) => {
    scanLocalSessionFiles(scanKey).then((files) => {
      if (files.length === 0) {
        setStatusMessage(t("sessionTree.noLocalConfigFound", { source }));
        return;
      }
      const extra = extraOptions?.() ?? {};
      const result = mergeImportResults(files.map((file) =>
        parser(file.text, {
          targetFolder: folderPath,
          sourcePath: file.relativePath || file.path,
          ...extra,
        }),
      ));
      queueImportPreview(result, folderPath, `${source} local config`);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importPlistSessions = (
    folderPath: string | null,
    source: string,
    parser: TextSessionParser,
  ) => {
    selectFilePath().then(async (path) => {
      if (!path) return;
      const file = await readPlistSessionFile(path);
      const result = parser(file.text, {
        targetFolder: folderPath,
        existingSessions: sessions,
        sourcePath: file.relativePath || file.path,
      });
      queueImportPreview(result, folderPath, source);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importOpenSshText = (folderPath: string | null, source: string, defaultSubfolder: string) => {
    openTextFileWithName(".ssh_config,.conf,.config,.txt,text/plain").then((file) => {
      if (!file) return;
      const imported = parseOpenSshConfig(file.text).map((session) => ({
        ...session,
        group_path: defaultSubfolder,
      }));
      queueSessionListImport(imported, folderPath, source, defaultSubfolder);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importScannedOpenSsh = (folderPath: string | null, scanKey: string, source: string, defaultSubfolder: string) => {
    scanLocalSessionFiles(scanKey).then((files) => {
      if (files.length === 0) {
        setStatusMessage(t("sessionTree.noOpenSshFound", { source }));
        return;
      }
      const imported = files.flatMap((file) => parseOpenSshConfig(file.text)).map((session) => ({
        ...session,
        group_path: defaultSubfolder,
      }));
      queueSessionListImport(imported, folderPath, `${source} local export`, defaultSubfolder);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const showTermiusGuide = () => {
    window.alert(t("sessionTree.termiusGuide"));
  };

  const tabbySecretImportOptions = (): Partial<SessionImportOptions> => ({
    includeSecrets: window.confirm(t("sessionTree.tabbyConfirmTitle")),
  });

  const unavailable = (label: string) => {
    setStatusMessage(t("sessionTree.notImplementedYet", { label }));
  };

  const folderContextMenu = (e: React.MouseEvent, folderPath: string | null) => {
    const normalized = normalizeGroupPath(folderPath);
    const isRoot = !normalized;
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const importChildren: MenuItem[] = [
      {
        label: t("sessionTree.contextImportMoba"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importMoba(folderPath),
      },
      {
        label: t("sessionTree.contextImportWsl"),
        icon: <TerminalIcon className="w-3 h-3" />,
        onClick: () => importBackendSessions(folderPath, "WSL", importWslSessions, "Imported / WSL"),
      },
      {
        label: t("sessionTree.contextImportExternalBash"),
        icon: <TerminalIcon className="w-3 h-3" />,
        onClick: () => importBackendSessions(folderPath, "External Bash", importExternalBashSessions, "Imported / External Bash"),
      },
      {
        label: t("sessionTree.contextImportPutty"),
        icon: <TerminalIcon className="w-3 h-3" />,
        onClick: () => importBackendSessions(folderPath, "PuTTY", importPuttySessions, "Imported / PuTTY"),
      },
      { label: "", separator: true },
      {
        label: t("sessionTree.contextImportXshell"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromXshFile"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importXshellFile(folderPath),
          },
          {
            label: t("sessionTree.fromZipArchive"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importXshellZip(folderPath),
          },
          {
            label: t("sessionTree.fromLocalXshell"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "xshell", "Xshell", parseXshellSessions),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportTabby"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromConfigYaml"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(
              folderPath,
              "Tabby",
              ".yaml,.yml,text/yaml,text/plain",
              parseTabbySessions,
              tabbySecretImportOptions,
            ),
          },
          {
            label: t("sessionTree.fromLocalTabby"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(
              folderPath,
              "tabby",
              "Tabby",
              parseTabbySessions,
              tabbySecretImportOptions,
            ),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportWindTerm"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromUserSessions"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "WindTerm", ".sessions,.json,user.sessions,application/json,text/plain", parseWindTermSessions),
          },
          {
            label: t("sessionTree.fromLocalWindTerm"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "windterm", "WindTerm", parseWindTermSessions),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportDbeaver"),
        icon: <Database className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromDbeaverDataSources"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importDbeaverFile(folderPath),
          },
          {
            label: t("sessionTree.fromLocalDbeaver"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedDbeaverSessions(folderPath),
          },
        ],
      },
      { label: "", separator: true },
      {
        label: t("sessionTree.contextImportIterm2"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromJsonPlist"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "iTerm2", ".json,.plist,application/json,text/xml", parseItermDynamicProfiles),
          },
          {
            label: t("sessionTree.fromBinaryPlist"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importPlistSessions(folderPath, "iTerm2 plist", parseItermDynamicProfiles),
          },
          {
            label: t("sessionTree.fromLocalIterm2"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "iterm2", "iTerm2", parseItermDynamicProfiles),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportTerminalApp"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromTerminalPlist"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "Terminal.app", ".terminal,.plist,text/xml", parseTerminalAppProfiles),
          },
          {
            label: t("sessionTree.fromBinaryTerminalPlist"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importPlistSessions(folderPath, "Terminal.app plist", parseTerminalAppProfiles),
          },
          {
            label: t("sessionTree.fromLocalTerminalApp"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "terminal", "Terminal.app", parseTerminalAppProfiles),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportTermius"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.showExportGuide"),
            icon: <FileText className="w-3 h-3" />,
            onClick: showTermiusGuide,
          },
          {
            label: t("sessionTree.fromOpenSshConfig"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importOpenSshText(folderPath, "Termius", "Imported / Termius"),
          },
          {
            label: t("sessionTree.detectLocalTermius"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedOpenSsh(folderPath, "termius", "Termius", "Imported / Termius"),
          },
        ],
      },
      { label: "", separator: true },
      {
        label: t("sessionTree.contextImportPuttyCm"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importTextSessions(folderPath, "PuTTYCM", ".xml,text/xml,application/xml", parseXmlConnectionSessions),
      },
      {
        label: t("sessionTree.contextImportSuperPutty"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importTextSessions(folderPath, "SuperPuTTY", ".xml,.settings,text/xml,application/xml", parseXmlConnectionSessions),
      },
      {
        label: t("sessionTree.contextImportMRemote"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromXmlFile"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "mRemote", ".xml,text/xml,application/xml", parseXmlConnectionSessions),
          },
          {
            label: t("sessionTree.fromLocalMRemoteNg"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "mremote", "mRemote", parseXmlConnectionSessions),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportExceed"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importTextSessions(folderPath, "Exceed", ".xml,.xs,.txt,text/xml,application/xml,text/plain", parseExceedSessions),
      },
      {
        label: t("sessionTree.contextImportSecureCrt"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromIniFile"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "SecureCRT", ".ini,text/plain", parseSecureCrtSessions),
          },
          {
            label: t("sessionTree.fromLocalSecureCrt"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "securecrt", "SecureCRT", parseSecureCrtSessions),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportRdm"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importTextSessions(folderPath, "Remote Desktop Manager", ".rdm,.xml,text/xml,application/xml", parseXmlConnectionSessions),
      },
      {
        label: t("sessionTree.contextImportZeroOmega"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importTextSessions(folderPath, "ZeroOmega", ".bak,.json,application/json,text/plain", parseZeroOmegaProxies),
      },
      { label: "", separator: true },
      {
        label: t("sessionTree.contextImportCsv"),
        icon: <FileText className="w-3 h-3" />,
        onClick: () => importCsv(folderPath),
      },
    ];

    ctx.show(e, [
      { label: t("sessionTree.contextNewSession"), icon: <Plus className="w-3 h-3" />, onClick: () => onNewSession?.(toStoredGroupPath(folderPath)) },
      { label: t("sessionTree.contextNewFolder"), icon: <FolderPlus className="w-3 h-3" />, onClick: () => createFolder(folderPath) },
      { label: t("sessionTree.contextEditFolder"), icon: <Edit3 className="w-3 h-3" />, disabled: isRoot, onClick: () => { if (normalized) renameFolder(normalized); } },
      { label: t("sessionTree.contextDeleteFolder"), icon: <Trash2 className="w-3 h-3" />, danger: true, disabled: isRoot, onClick: () => { if (normalized) deleteFolder(normalized); } },
      { label: t("sessionTree.contextCreateDesktopShortcut"), icon: <Star className="w-3 h-3" />, onClick: () => unavailable(t("sessionTree.contextCreateDesktopShortcut")) },
      { label: "", separator: true },
      { label: t("sessionTree.contextImportTaomni"), icon: <Upload className="w-3 h-3" />, onClick: () => importJson(folderPath) },
      { label: t("sessionTree.contextImportThirdParty"), icon: <Upload className="w-3 h-3" />, children: importChildren },
      { label: "", separator: true },
      { label: t("sessionTree.contextExportTaomni"), icon: <Download className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exportFolder(folderPath) },
      { label: t("sessionTree.contextExportMoba"), icon: <Download className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exportMobaFolder(folderPath) },
      { label: t("sessionTree.contextExportCsv"), icon: <FileText className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exportCsvFolder(folderPath) },
      { label: t("sessionTree.contextGenerateHtml"), icon: <FileText className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => generateHtml(folderPath) },
      { label: "", separator: true },
      { label: t("sessionTree.contextExecuteAll"), icon: <Play className="w-3 h-3" />, disabled: folderSessions.length === 0 || !onConnectSession, onClick: () => executeFolder(folderPath) },
      { label: "", separator: true },
      { label: t("sessionTree.contextShare"), icon: <Share2 className="w-3 h-3" />, onClick: () => unavailable(t("sessionTree.contextShare")) },
    ]);
  };

  const sessionContextMenu = (e: React.MouseEvent, session: SessionConfig) => {
    const selectedContextSessions = effectiveSelectedSessionIds.has(session.id)
      ? sessions.filter((candidate) => effectiveSelectedSessionIds.has(candidate.id))
      : [session];
    // Right-clicking an item outside the current selection narrows to just it.
    // Right-clicking one already selected preserves the whole multi-selection.
    if (!effectiveSelectedSessionIds.has(session.id)) {
      selectSingleSession(session);
    }
    const targetIds = selectedContextSessions.map((candidate) => candidate.id);
    const hasMultiSelection = selectedContextSessions.length > 1;
    const moveChildren: MenuItem[] = [
      { label: SESSION_ROOT_LABEL, icon: <FolderOpen className="w-3 h-3" />, onClick: () => void moveSessionsToGroup(targetIds, null) },
      ...folderPaths.map((path) => ({
        label: folderOptionLabel(path),
        icon: <Folder className="w-3 h-3" />,
        onClick: () => {
          void moveSessionsToGroup(targetIds, path);
          expandPath(path);
        },
      })),
    ];

    const items: MenuItem[] = [
      ...(hasMultiSelection ? [
        {
          label: t("sessionTree.contextConnectSelected", { count: selectedContextSessions.length }),
          testId: `context-menu-item-connect-selected-sessions-${selectedContextSessions.length}`,
          icon: <Play className="w-3 h-3" />,
          onClick: () => connectSessions(selectedContextSessions, t("sessionTree.fromSelected")),
          disabled: !onConnectSession,
        },
        { label: "", separator: true },
      ] satisfies MenuItem[] : []),
      { label: t("sessionTree.contextConnect"), icon: <Play className="w-3 h-3" />, onClick: () => onConnectSession?.(session), disabled: !onConnectSession },
      { label: t("sessionTree.contextEdit"), icon: <Edit3 className="w-3 h-3" />, onClick: () => onEditSession?.(session), disabled: !onEditSession },
      {
        label: hasMultiSelection ? t("sessionTree.contextDuplicateCount", { count: targetIds.length }) : t("sessionTree.contextDuplicate"),
        testId: hasMultiSelection ? `context-menu-item-duplicate-selected-sessions-${targetIds.length}` : undefined,
        icon: <Copy className="w-3 h-3" />,
        onClick: () => void duplicateSessions(targetIds),
      },
      { label: t("sessionTree.contextMoveToFolder"), icon: <Folder className="w-3 h-3" />, children: moveChildren },
      { label: "", separator: true },
      {
        label: hasMultiSelection ? t("sessionTree.contextDeleteCount", { count: targetIds.length }) : t("sessionTree.contextDelete"),
        testId: hasMultiSelection ? `context-menu-item-delete-selected-sessions-${targetIds.length}` : undefined,
        icon: <Trash2 className="w-3 h-3" />,
        danger: true,
        onClick: () => {
          if (hasMultiSelection) {
            setConfirmPrompt({
              title: t("sessionTree.confirmDeleteSelectedTitle"),
              message: t("sessionTree.confirmDeleteSelected", { count: targetIds.length }),
              confirmLabel: t("sessionTree.deleteAction"),
              danger: true,
              onConfirm: () => {
                setConfirmPrompt(null);
                void removeSessions(targetIds);
              },
            });
          } else {
            setConfirmPrompt({
              title: t("sessionTree.confirmDeleteTitle"),
              message: t("sessionTree.confirmDelete", { name: session.name }),
              confirmLabel: t("sessionTree.deleteAction"),
              danger: true,
              onConfirm: () => {
                setConfirmPrompt(null);
                void removeSessions([session.id]);
              },
            });
          }
        },
      },
    ];
    ctx.show(e, items);
  };

  return (
    <>
      {folderDialog && (
        <FolderNameDialog
          parentPath={folderDialog.parentPath}
          initialName={folderDialog.mode === "rename" ? folderDialog.initialName : t("sessionTree.newFolderDefaultName")}
          title={folderDialog.mode === "rename" ? t("sessionTree.folderEditTitle") : t("sessionTree.folderNewTitle")}
          onCancel={() => setFolderDialog(null)}
          onSubmit={handleFolderDialogSubmit}
        />
      )}
      {pendingImport && (
        <SessionImportPreview
          source={pendingImport.source}
          result={pendingImport.result}
          targetFolder={pendingImport.folderPath}
          onCancel={() => setPendingImport(null)}
          onConfirm={(selectedIds) => void confirmPendingImport(selectedIds)}
        />
      )}
      {externalVaultPrompt && (
        <ExternalVaultUnlockDialog
          toolName={externalVaultPrompt.toolName}
          title={externalVaultPrompt.title}
          description={externalVaultPrompt.description}
          passwordLabel={externalVaultPrompt.passwordLabel}
          errorMessage={externalVaultPrompt.errorMessage}
          onSubmit={externalVaultPrompt.onSubmit}
          onSkip={externalVaultPrompt.onSkip}
        />
      )}
      {confirmPrompt && (
        <ConfirmDialog
          title={confirmPrompt.title}
          message={confirmPrompt.message}
          confirmLabel={confirmPrompt.confirmLabel}
          danger={confirmPrompt.danger}
          onCancel={() => setConfirmPrompt(null)}
          onConfirm={confirmPrompt.onConfirm}
        />
      )}
      <div
        data-testid="session-tree"
        className="flex-1 taomni-scroll-y"
        onContextMenu={(event) => folderContextMenu(event, null)}
      >
        {ctx.render}
        <TreeFolder
          node={tree}
          count={countNodeSessions(tree)}
          open={expanded.root !== false}
          onToggle={() => toggle("root")}
          onContextMenu={(event) => folderContextMenu(event, null)}
          onDropSession={(sessionId) => handleDrop(null, sessionId)}
          onDragOverFolder={() => handleDragOver(null)}
          onDragLeave={() => setDragOverGroup(null)}
          dragOver={dragOverGroup === "root"}
        >
          <FolderContents
            node={tree}
            expanded={expanded}
            searchQuery={searchQuery}
            selectedSessionIds={effectiveSelectedSessionIds}
            dragOverGroup={dragOverGroup}
            onToggle={toggle}
            onFolderContextMenu={folderContextMenu}
            onSessionContextMenu={sessionContextMenu}
            onDropSession={handleDrop}
            onDragOverFolder={handleDragOver}
            onDragLeave={() => setDragOverGroup(null)}
            onSessionClick={handleSessionClick}
            onConnectSession={onConnectSession}
          />
          {filteredSessions.length === 0 && !loading && (
            <div className="pl-6 py-2 text-[var(--taomni-text-muted)]" style={{ fontSize: "calc(var(--taomni-ui-font-size) - 1px)" }}>
              {searchQuery ? t("sessionTree.emptyNoMatching") : t("sessionTree.emptyNoSessions")}
            </div>
          )}
        </TreeFolder>

    </div>
    </>
  );
}

function FolderContents({
  node,
  expanded,
  searchQuery,
  selectedSessionIds,
  dragOverGroup,
  onToggle,
  onFolderContextMenu,
  onSessionContextMenu,
  onDropSession,
  onDragOverFolder,
  onDragLeave,
  onSessionClick,
  onConnectSession,
}: {
  node: FolderNode;
  expanded: Record<string, boolean>;
  searchQuery: string;
  selectedSessionIds: ReadonlySet<string>;
  dragOverGroup: string | null;
  onToggle: (key: string) => void;
  onFolderContextMenu: (event: React.MouseEvent, path: string | null) => void;
  onSessionContextMenu: (event: React.MouseEvent, session: SessionConfig) => void;
  onDropSession: (groupPath: string | null, sessionId: string) => void;
  onDragOverFolder: (groupPath: string | null) => void;
  onDragLeave: () => void;
  onSessionClick: (event: React.MouseEvent, session: SessionConfig) => void;
  onConnectSession?: (session: SessionConfig) => void;
}) {
  return (
    <>
      {node.folders.map((folder) => {
        const key = folderKey(folder.path);
        const isOpen = searchQuery ? true : !!expanded[key];

        return (
          <TreeFolder
            key={key}
            node={folder}
            count={countNodeSessions(folder)}
            open={isOpen}
            onToggle={() => onToggle(key)}
            onContextMenu={(event) => onFolderContextMenu(event, folder.path)}
            onDropSession={(sessionId) => onDropSession(folder.path, sessionId)}
            onDragOverFolder={() => onDragOverFolder(folder.path)}
            onDragLeave={onDragLeave}
            dragOver={dragOverGroup === key}
          >
            <FolderContents
              node={folder}
              expanded={expanded}
              searchQuery={searchQuery}
              selectedSessionIds={selectedSessionIds}
              dragOverGroup={dragOverGroup}
              onToggle={onToggle}
              onFolderContextMenu={onFolderContextMenu}
              onSessionContextMenu={onSessionContextMenu}
              onDropSession={onDropSession}
              onDragOverFolder={onDragOverFolder}
              onDragLeave={onDragLeave}
              onSessionClick={onSessionClick}
              onConnectSession={onConnectSession}
            />
          </TreeFolder>
        );
      })}

      {node.sessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          selected={selectedSessionIds.has(session.id)}
          onClick={(event) => onSessionClick(event, session)}
          onDoubleClick={() => onConnectSession?.(session)}
          onContextMenu={(event) => onSessionContextMenu(event, session)}
        />
      ))}
    </>
  );
}

function TreeFolder({
  node,
  count,
  open,
  onToggle,
  children,
  onContextMenu,
  onDropSession,
  onDragOverFolder,
  onDragLeave,
  dragOver,
}: {
  node: FolderNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  onContextMenu?: (event: React.MouseEvent) => void;
  onDropSession?: (sessionId: string) => void;
  onDragOverFolder?: () => void;
  onDragLeave?: () => void;
  dragOver?: boolean;
}) {
  const isRoot = node.path === null;
  const hasChildren = node.folders.length > 0 || node.sessions.length > 0;
  const headerRef = useRef<HTMLDivElement>(null);

  useCustomDropTarget<HTMLDivElement>(headerRef, {
    accepts: (data: CustomDragData) =>
      data.mime === SESSION_DRAG_MIME && !!onDropSession,
    onDragEnter: () => onDragOverFolder?.(),
    onDragOver: () => onDragOverFolder?.(),
    onDragLeave: () => onDragLeave?.(),
    onDrop: (detail) => {
      const payload = detail.data.payload as SessionDragPayload | null;
      if (payload?.sessionId) onDropSession?.(payload.sessionId);
    },
  });

  return (
    <div>
      <div
        ref={headerRef}
        className="taomni-tree-row"
        data-drag-over={dragOver}
        style={dragOver ? { background: "var(--taomni-selected)" } : undefined}
        onClick={onToggle}
        onContextMenu={onContextMenu}
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-slate-500" />
        ) : (
          <ChevronRight className="w-3 h-3 text-slate-500" />
        )}
        {open || isRoot ? (
          <FolderOpen className="w-3.5 h-3.5 text-amber-600" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-amber-600" />
        )}
        <span className="flex-1 font-medium truncate">{node.name}</span>
        {count !== undefined && hasChildren && (
          <span className="text-slate-500" style={{ fontSize: "calc(var(--taomni-ui-font-size) - 2px)" }}>({count})</span>
        )}
      </div>
      {open && <div className="pl-4">{children}</div>}
    </div>
  );
}

function SessionItem({
  session,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  session: SessionConfig;
  selected: boolean;
  onClick: (event: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const typeLabel = sessionTypeLabel(session.session_type, session.options_json);
  const icon = sessionIcon(typeLabel);
  const ref = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    startCustomDrag({
      event: e,
      data: {
        mime: SESSION_DRAG_MIME,
        payload: { sessionId: session.id } satisfies SessionDragPayload,
      },
      ghostText: session.name,
      ghostElement: el,
    });
  };

  return (
    <div
      ref={ref}
      data-testid="session-tree-item"
      data-session-id={session.id}
      data-session-name={session.name}
      data-session-type={typeLabel}
      className="taomni-tree-row group"
      data-selected={selected}
      aria-selected={selected}
      style={selected ? { background: "var(--taomni-selected)" } : undefined}
      onPointerDown={handlePointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <span className="w-3" />
      {icon}
      <span className="flex-1 truncate">
        {session.name}
        {session.username && session.host && (
          <span className="text-[var(--taomni-text-muted)]">
            {" "}({session.username}@{session.host})
          </span>
        )}
      </span>
      <span
        className="px-1 rounded"
        style={{ fontSize: "calc(var(--taomni-ui-font-size) - 2px)", background: "#e1ecfa", color: "#1e3a5f" }}
      >
        {typeLabel}
      </span>
    </div>
  );
}

function sessionIcon(type: string) {
  switch (type) {
    case "SSH":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />;
    case "RDP":
      return <Monitor className="w-3.5 h-3.5" style={{ color: "#a04b9c" }} />;
    case "VNC":
      return <Monitor className="w-3.5 h-3.5" style={{ color: "#c97a23" }} />;
    case "SFTP":
    case "FTP":
      return <Folder className="w-3.5 h-3.5" style={{ color: "#3b7ac2" }} />;
    case "Serial":
      return <Wifi className="w-3.5 h-3.5" style={{ color: "#236a98" }} />;
    case "WSL":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#0078d4" }} />;
    case "LocalShell":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#62d36f" }} />;
    case "MySQL":
      return <Database className="w-3.5 h-3.5" style={{ color: "#00758f" }} />;
    case "PostgreSQL":
      return <Database className="w-3.5 h-3.5" style={{ color: "#336791" }} />;
    case "SQLServer":
      return <Database className="w-3.5 h-3.5" style={{ color: "#cc2927" }} />;
    case "ClickHouse":
      return <Database className="w-3.5 h-3.5" style={{ color: "#e6a817" }} />;
    case "Redis":
      return <Database className="w-3.5 h-3.5" style={{ color: "#d82c20" }} />;
    case "File":
      return <FileText className="w-3.5 h-3.5" style={{ color: "var(--taomni-text-muted)" }} />;
    default:
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />;
  }
}

function buildSessionTree(sessions: SessionConfig[], groups: SessionGroup[]): FolderNode {
  const root: FolderNode = {
    name: SESSION_ROOT_LABEL,
    path: null,
    folders: [],
    sessions: [],
  };

  const nodes = new Map<string, FolderNode>();

  const ensureFolder = (path: string): FolderNode => {
    const normalized = normalizeGroupPath(path);
    if (!normalized) return root;
    const existing = nodes.get(normalized);
    if (existing) return existing;

    const parentPath = parentGroupPath(normalized);
    const parent = parentPath ? ensureFolder(parentPath) : root;
    const node: FolderNode = {
      name: leafGroupName(normalized),
      path: normalized,
      folders: [],
      sessions: [],
    };
    nodes.set(normalized, node);
    parent.folders.push(node);
    return node;
  };

  for (const path of collectFolderPaths(sessions, groups)) {
    ensureFolder(path);
  }

  for (const session of sessions) {
    const path = normalizeGroupPath(session.group_path);
    if (path) ensureFolder(path).sessions.push(session);
    else root.sessions.push(session);
  }

  sortFolder(root);
  return root;
}

function sortFolder(node: FolderNode) {
  node.folders.sort((a, b) => a.name.localeCompare(b.name));
  node.sessions.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  for (const folder of node.folders) sortFolder(folder);
}

function countNodeSessions(node: FolderNode): number {
  return node.sessions.length + node.folders.reduce((sum, folder) => sum + countNodeSessions(folder), 0);
}

function folderKey(path: string | null | undefined): string {
  return normalizeGroupPath(path) ?? "root";
}

function sessionsInFolder(sessions: SessionConfig[], folderPath: string | null | undefined): SessionConfig[] {
  const normalized = normalizeGroupPath(folderPath);
  if (!normalized) return sessions;
  return sessions.filter((session) => groupPathContains(normalized, session.group_path));
}

function uniqueSessionsById(sessions: readonly SessionConfig[]): SessionConfig[] {
  const seen = new Set<string>();
  const unique: SessionConfig[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unique.push(session);
  }
  return unique;
}

function filterSessions(sessions: SessionConfig[], query: string): SessionConfig[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((session) => {
    const haystack = [
      session.name,
      sessionTypeLabel(session.session_type, session.options_json),
      folderOptionLabel(session.group_path),
      session.host,
      session.username ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}
