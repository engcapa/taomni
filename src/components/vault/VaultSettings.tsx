import { useEffect, useState } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { VaultSetupDialog } from "./VaultSetupDialog";
import { VaultUnlockDialog } from "./VaultUnlockDialog";
import { VaultEntriesDialog } from "./VaultEntriesDialog";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";

type Action = null | "init" | "unlock" | "change-master";

export function VaultSettings() {
  const t = useT();
  const {
    state,
    entries,
    refresh,
    init,
    unlock,
    lock,
    changeMaster,
    reloadEntries,
  } = useVaultStore();
  const vaultUnlockMode = useAppStore((s) => s.vaultUnlockMode);
  const setVaultUnlockMode = useAppStore((s) => s.setVaultUnlockMode);

  const [action, setAction] = useState<Action>(null);
  const [oldPw, setOldPw] = useState("");
  const [newPw1, setNewPw1] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showEntriesDialog, setShowEntriesDialog] = useState(false);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (state === "unlocked") {
      void reloadEntries().catch(() => undefined);
    }
  }, [state, reloadEntries]);

  const handleChangeMaster = async () => {
    if (newPw1.length < 8) {
      setError(t("vaultSettings.newTooShort"));
      return;
    }
    if (newPw1 !== newPw2) {
      setError(t("vaultSettings.newMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await changeMaster(oldPw, newPw1);
      setInfo(t("vaultSettings.masterUpdated"));
      setOldPw("");
      setNewPw1("");
      setNewPw2("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes("VAULT_BAD_PASSWORD") ? t("vaultSettings.currentWrong") : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  const stateBadge = (
    <span
      data-testid="vault-state-badge"
      className="px-2 py-0.5 text-[11px] rounded"
      style={{
        background:
          state === "unlocked"
            ? "var(--taomni-accent)"
            : state === "locked"
              ? "var(--taomni-hover)"
              : "transparent",
        color: state === "unlocked" ? "white" : "var(--taomni-text-muted)",
        border:
          state === "empty" ? "1px dashed var(--taomni-card-border)" : "1px solid transparent",
      }}
    >
      {state}
    </span>
  );

  return (
    <div className="p-4" data-testid="vault-settings">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-sm font-semibold">{t("vaultSettings.sectionTitle")}</div>
        {stateBadge}
      </div>

      <div className="text-[12px] mb-4" style={{ color: "var(--taomni-text-muted)" }}>
        {t("vaultSettings.description")}
      </div>

      <div className="mb-4" data-testid="vault-unlock-mode-setting">
        <div className="text-[12px] font-semibold mb-1">{t("vaultSettings.unlockModeTitle")}</div>
        <div className="text-[11px] mb-2" style={{ color: "var(--taomni-text-muted)" }}>
          {t("vaultSettings.unlockModeDescription")}
        </div>
        <div
          role="group"
          aria-label={t("vaultSettings.unlockModeTitle")}
          className="inline-flex overflow-hidden rounded border"
          style={{ borderColor: "var(--taomni-card-border)" }}
        >
          <button
            type="button"
            data-testid="vault-unlock-mode-startup"
            aria-pressed={vaultUnlockMode === "startup"}
            className="min-w-[116px] px-3 py-1.5 text-[12px] transition-colors"
            style={{
              background: vaultUnlockMode === "startup" ? "var(--taomni-accent)" : "transparent",
              color: vaultUnlockMode === "startup" ? "white" : "var(--taomni-text)",
            }}
            onClick={() => setVaultUnlockMode("startup")}
          >
            {t("vaultSettings.unlockModeStartup")}
          </button>
          <button
            type="button"
            data-testid="vault-unlock-mode-on-demand"
            aria-pressed={vaultUnlockMode === "on-demand"}
            className="min-w-[116px] border-l px-3 py-1.5 text-[12px] transition-colors"
            style={{
              borderColor: "var(--taomni-card-border)",
              background: vaultUnlockMode === "on-demand" ? "var(--taomni-accent)" : "transparent",
              color: vaultUnlockMode === "on-demand" ? "white" : "var(--taomni-text)",
            }}
            onClick={() => setVaultUnlockMode("on-demand")}
          >
            {t("vaultSettings.unlockModeOnDemand")}
          </button>
        </div>
        <div
          className="mt-2 text-[11px]"
          style={{ color: "var(--taomni-text-muted)" }}
          data-testid="vault-unlock-mode-hint"
        >
          {vaultUnlockMode === "startup"
            ? t("vaultSettings.unlockModeStartupHint")
            : t("vaultSettings.unlockModeOnDemandHint")}
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {state === "empty" && (
          <button
            type="button"
            data-testid="vault-init-button"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: "var(--taomni-accent)" }}
            onClick={() => setAction("init")}
          >
            {t("vaultSettings.setMasterPassword")}
          </button>
        )}
        {state === "locked" && (
          <button
            type="button"
            data-testid="vault-unlock-button"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: "var(--taomni-accent)" }}
            onClick={() => setAction("unlock")}
          >
            {t("vaultSettings.unlock")}
          </button>
        )}
        {state === "unlocked" && (
          <>
            <button
              type="button"
              data-testid="vault-lock-button"
              className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
              onClick={() => void lock()}
            >
              {t("vaultSettings.lockNow")}
            </button>
            <button
              type="button"
              data-testid="vault-change-master-button"
              className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
              onClick={() => {
                setAction("change-master");
                setError(null);
                setInfo(null);
              }}
            >
              {t("vaultSettings.changeMasterPassword")}
            </button>
          </>
        )}
      </div>

      {action === "change-master" && (
        <div
          className="mb-4 p-3 rounded"
          style={{ border: "1px solid var(--taomni-card-border)" }}
          data-testid="vault-change-master-form"
        >
          <div className="text-[12px] font-semibold mb-2">{t("vaultSettings.changeMasterPassword")}</div>
          <input
            type="password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            placeholder={t("vaultSettings.currentPassword")}
            className="taomni-input w-full mb-2"
            autoComplete="current-password"
            data-testid="vault-change-master-old"
          />
          <input
            type="password"
            value={newPw1}
            onChange={(e) => setNewPw1(e.target.value)}
            placeholder={t("vaultSettings.newPassword")}
            className="taomni-input w-full mb-2"
            autoComplete="new-password"
            data-testid="vault-change-master-new1"
          />
          <input
            type="password"
            value={newPw2}
            onChange={(e) => setNewPw2(e.target.value)}
            placeholder={t("vaultSettings.confirmNewPassword")}
            className="taomni-input w-full mb-2"
            autoComplete="new-password"
            data-testid="vault-change-master-new2"
          />
          {error && (
            <div className="text-[12px] mb-2" style={{ color: "var(--taomni-error, #c33)" }}>
              {error}
            </div>
          )}
          {info && (
            <div className="text-[12px] mb-2" style={{ color: "var(--taomni-accent)" }}>
              {info}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
              onClick={() => {
                setAction(null);
                setError(null);
                setInfo(null);
              }}
              disabled={busy}
            >
              {t("vaultSettings.close")}
            </button>
            <button
              type="button"
              className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
              style={{ background: "var(--taomni-accent)" }}
              onClick={() => void handleChangeMaster()}
              disabled={busy}
              data-testid="vault-change-master-submit"
            >
              {busy ? t("vaultSettings.updating") : t("vaultSettings.update")}
            </button>
          </div>
        </div>
      )}

      {state === "unlocked" && (
        <div data-testid="vault-entries-section" className="flex flex-col gap-2">
          <div className="text-[12px] font-semibold">
            {t("vaultSettings.savedEntries", { count: entries.length })}
          </div>
          <div>
            <button
              type="button"
              data-testid="vault-manage-entries-button"
              className="px-3 py-1 text-[12px] rounded text-white hover:opacity-90 transition-opacity"
              style={{ background: "var(--taomni-accent)" }}
              onClick={() => setShowEntriesDialog(true)}
            >
              {t("vaultSettings.manageEntries")}
            </button>
          </div>
        </div>
      )}

      {showEntriesDialog && (
        <VaultEntriesDialog onClose={() => setShowEntriesDialog(false)} />
      )}

      {action === "init" && (
        <VaultSetupDialog
          onCancel={() => setAction(null)}
          onSubmit={async (pw) => {
            await init(pw);
            setAction(null);
          }}
        />
      )}

      {action === "unlock" && (
        <VaultUnlockDialog
          onCancel={() => setAction(null)}
          onSubmit={async (pw) => {
            await unlock(pw);
            setAction(null);
          }}
        />
      )}
    </div>
  );
}
