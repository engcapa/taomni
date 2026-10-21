import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { BackupManifest, BackupScope } from "../../lib/backup";
import { useT } from "../../lib/i18n";
import { selectFilePath, selectSaveDirectory, selectSaveFilePath } from "../../lib/ipc";
import { relaunchApp } from "../../lib/updateService";
import { useBackupStore } from "../../stores/backupStore";
import { useVaultStore } from "../../stores/vaultStore";
import { BackupSettingsView } from "./backup/BackupSettingsView";

export function BackupSettingsPanel() {
  const t = useT();
  const vaultState = useVaultStore((s) => s.state);
  const refreshVault = useVaultStore((s) => s.refresh);

  const {
    policy,
    defaultBackupDir,
    history,
    creating,
    restoring,
    error,
    loadAll,
    refreshHistory,
    updatePolicy,
    triggerBackup,
    inspectArchive,
    performStageRestore,
    deleteBackup,
    clearError,
  } = useBackupStore();

  // Create backup form state
  const [scope, setScope] = useState<BackupScope>("core");
  const [includeMail, setIncludeMail] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Restore inspection dialog state
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [selectedRestorePath, setSelectedRestorePath] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [manifest, setManifest] = useState<BackupManifest | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreVaultPassword, setRestoreVaultPassword] = useState("");
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [restoreStaged, setRestoreStaged] = useState(false);

  useEffect(() => {
    void loadAll();
    void refreshVault();
  }, [loadAll, refreshVault]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    // Tauri events stay within one process. Read shared history and policy
    // while this panel is open to observe backups made by another instance.
    const refreshTimer = window.setInterval(() => {
      if (!disposed) void refreshHistory();
    }, 15_000);
    void listen("backup-completed", () => {
      if (!disposed) void refreshHistory();
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
        // Close the gap between the initial load and listener registration.
        void refreshHistory();
      }
    }).catch((error) => {
      console.error("Failed to listen for backup completion", error);
    });
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      unlisten?.();
    };
  }, [refreshHistory]);

  const effectiveBackupDir = policy?.customBackupDir?.trim() || defaultBackupDir;
  const isCustomDir = Boolean(policy?.customBackupDir?.trim());

  // Handle changing custom directory
  const handleChangeDirectory = async () => {
    try {
      const selected = await selectSaveDirectory(effectiveBackupDir);
      if (selected && selected.trim()) {
        await updatePolicy({ customBackupDir: selected.trim() });
        await refreshHistory();
      }
    } catch (e) {
      console.error("Failed to select backup directory", e);
    }
  };

  // Handle reset to default directory
  const handleResetDefaultDirectory = async () => {
    try {
      await updatePolicy({ customBackupDir: null });
      await refreshHistory();
    } catch (e) {
      console.error("Failed to reset backup directory", e);
    }
  };

  // Handle instant backup directly into the configured backup directory
  const handleBackupNow = async () => {
    setActionSuccess(null);
    setActionError(null);
    clearError();

    try {
      await triggerBackup({
        scope,
        customOptions: { includeMail },
        password: usePassword && password.trim() ? password.trim() : undefined,
      });
      setActionSuccess(t("backupSettings.createSuccess"));
    } catch (e) {
      console.error("Failed to create backup", e);
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  // Handle backup export to custom path chosen by user
  const handleExportBackup = async () => {
    setActionSuccess(null);
    setActionError(null);
    clearError();

    const nowStr = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const defaultName = `taomni_backup_${nowStr}.taobak`;
    try {
      const target = await selectSaveFilePath(defaultName, effectiveBackupDir);
      if (!target) return;

      await triggerBackup({
        scope,
        customOptions: { includeMail },
        targetPath: target,
        password: usePassword && password.trim() ? password.trim() : undefined,
      });
      setActionSuccess(t("backupSettings.createSuccess"));
    } catch (e) {
      console.error("Failed to export backup", e);
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  // Trigger file selection for restore
  const handleSelectRestoreFile = async () => {
    try {
      const file = await selectFilePath(effectiveBackupDir);
      if (file) {
        openRestoreModal(file);
      }
    } catch (e) {
      console.error("Failed to pick restore file", e);
    }
  };

  const openRestoreModal = async (filePath: string) => {
    setSelectedRestorePath(filePath);
    setRestoreModalOpen(true);
    setInspectError(null);
    setManifest(null);
    setRestorePassword("");
    setRestoreVaultPassword("");
    setRestoreStaged(false);
    setInspecting(true);

    try {
      const meta = await inspectArchive(filePath);
      setManifest(meta);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("BACKUP_PASSWORD_REQUIRED")) {
        setInspectError(t("backupSettings.inputPasswordForDecrypt"));
      } else {
        setInspectError(msg);
      }
    } finally {
      setInspecting(false);
    }
  };

  // Retry inspect with password
  const handleRetryInspectWithPassword = async () => {
    if (!selectedRestorePath) return;
    setInspecting(true);
    setInspectError(null);
    try {
      const meta = await inspectArchive(selectedRestorePath, restorePassword);
      setManifest(meta);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInspectError(
        msg.includes("BACKUP_BAD_PASSWORD")
          ? t("backupSettings.badArchivePassword")
          : msg,
      );
    } finally {
      setInspecting(false);
    }
  };

  // Execute restore and relaunch
  const handleConfirmRestore = async () => {
    if (!selectedRestorePath) return;
    setInspectError(null);

    if (vaultState !== "empty" && !restoreVaultPassword.trim()) {
      setInspectError(t("backupSettings.vaultPasswordRequired"));
      return;
    }

    try {
      await performStageRestore(
        selectedRestorePath,
        restorePassword.trim() ? restorePassword.trim() : undefined,
        vaultState !== "empty" ? restoreVaultPassword.trim() : undefined,
      );
      setRestoreStaged(true);
      setTimeout(async () => {
        try {
          await relaunchApp();
        } catch (relaunchErr) {
          console.error("Failed to relaunch app", relaunchErr);
        }
      }, 1500);
    } catch (e) {
      console.error("Failed to stage restore", e);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("VAULT_BAD_PASSWORD")) {
        setInspectError(t("backupSettings.vaultBadPassword"));
      } else if (msg.includes("VAULT_PASSWORD_REQUIRED")) {
        setInspectError(t("backupSettings.vaultPasswordRequired"));
      } else {
        setInspectError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const handleDeleteItem = async (fileName: string) => {
    if (window.confirm(t("backupSettings.confirmDelete"))) {
      try {
        await deleteBackup(fileName);
      } catch (e) {
        console.error("Failed to delete backup", e);
      }
    }
  };

  return <BackupSettingsView
    t={t}
    error={error}
    actionSuccess={actionSuccess}
    openRestoreModal={openRestoreModal}
    isCustomDir={isCustomDir}
    effectiveBackupDir={effectiveBackupDir}
    handleChangeDirectory={handleChangeDirectory}
    handleResetDefaultDirectory={handleResetDefaultDirectory}
    scope={scope}
    setScope={setScope}
    setIncludeMail={setIncludeMail}
    includeMail={includeMail}
    usePassword={usePassword}
    setUsePassword={setUsePassword}
    password={password}
    setPassword={setPassword}
    actionError={actionError}
    creating={creating}
    handleExportBackup={handleExportBackup}
    handleBackupNow={handleBackupNow}
    policy={policy}
    updatePolicy={updatePolicy}
    handleSelectRestoreFile={handleSelectRestoreFile}
    history={history}
    refreshHistory={refreshHistory}
    handleDeleteItem={handleDeleteItem}
    restoreModalOpen={restoreModalOpen}
    setRestoreModalOpen={setRestoreModalOpen}
    inspecting={inspecting}
    manifest={manifest}
    vaultState={vaultState}
    restoreVaultPassword={restoreVaultPassword}
    setRestoreVaultPassword={setRestoreVaultPassword}
    setInspectError={setInspectError}
    inspectError={inspectError}
    restorePassword={restorePassword}
    setRestorePassword={setRestorePassword}
    handleRetryInspectWithPassword={handleRetryInspectWithPassword}
    restoreStaged={restoreStaged}
    restoring={restoring}
    handleConfirmRestore={handleConfirmRestore}
  />;
}
