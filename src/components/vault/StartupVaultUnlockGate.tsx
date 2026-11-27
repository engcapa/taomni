import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useVaultStore } from "../../stores/vaultStore";
import { VaultUnlockDialog } from "./VaultUnlockDialog";

type StartupVaultGateState = "checking" | "locked" | "ready";

export function StartupVaultUnlockGate({ children }: { children: ReactNode }) {
  const t = useT();
  const unlockMode = useAppStore((s) => s.vaultUnlockMode);
  const refresh = useVaultStore((s) => s.refresh);
  const unlock = useVaultStore((s) => s.unlock);
  const dismissed = useRef(false);
  const [gateState, setGateState] = useState<StartupVaultGateState>(
    unlockMode === "startup" ? "checking" : "ready",
  );

  useEffect(() => {
    if (unlockMode !== "startup") {
      setGateState("ready");
      return;
    }

    setGateState("checking");
    dismissed.current = false;
    let disposed = false;
    void refresh()
      .then(() => {
        if (disposed || dismissed.current) return;
        setGateState(useVaultStore.getState().state === "locked" ? "locked" : "ready");
      })
      .catch(() => {
        if (!disposed && !dismissed.current) setGateState("ready");
      });

    return () => {
      disposed = true;
    };
  }, [refresh, unlockMode]);

  const dismiss = () => {
    dismissed.current = true;
    setGateState("ready");
  };

  return (
    <>
      {children}
      {gateState === "checking" && <StartupVaultCheckOverlay onCancel={dismiss} />}
      {gateState === "locked" && (
        <VaultUnlockDialog
          reason={t("vault.startupUnlockReason")}
          onCancel={dismiss}
          zIndex={10001}
          onSubmit={async (pw) => {
            await unlock(pw);
            setGateState("ready");
          }}
        />
      )}
    </>
  );
}

function StartupVaultCheckOverlay({ onCancel }: { onCancel: () => void }) {
  const t = useT();

  return (
    <div
      data-testid="startup-vault-check"
      className="fixed inset-0 flex items-center justify-center"
      style={{
        background: "var(--taomni-overlay)",
        zIndex: "var(--taomni-z-blocking-gate)",
      }}
    >
      <div
        className="flex flex-col items-center gap-3 rounded border px-5 py-4 text-ui-body shadow-lg"
        style={{
          background: "var(--taomni-card-bg)",
          color: "var(--taomni-text)",
          borderColor: "var(--taomni-card-border)",
        }}
      >
        <span>{t("common.loading")}</span>
        <button type="button" data-testid="startup-vault-check-cancel" className="taomni-btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
