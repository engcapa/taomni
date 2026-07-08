import { useEffect, useState, type ReactNode } from "react";
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
  const [gateState, setGateState] = useState<StartupVaultGateState>(
    unlockMode === "startup" ? "checking" : "ready",
  );

  useEffect(() => {
    if (unlockMode !== "startup") {
      setGateState("ready");
      return;
    }

    setGateState("checking");
    let disposed = false;
    void refresh()
      .then(() => {
        if (disposed) return;
        setGateState(useVaultStore.getState().state === "locked" ? "locked" : "ready");
      })
      .catch(() => {
        if (!disposed) setGateState("ready");
      });

    return () => {
      disposed = true;
    };
  }, [refresh, unlockMode]);

  return (
    <>
      {children}
      {gateState === "checking" && <StartupVaultCheckOverlay />}
      {gateState === "locked" && (
        <VaultUnlockDialog
          reason={t("vault.startupUnlockReason")}
          cancellable={false}
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

function StartupVaultCheckOverlay() {
  const t = useT();

  return (
    <div
      data-testid="startup-vault-check"
      className="fixed inset-0 flex items-center justify-center"
      style={{
        background: "rgba(0,0,0,0.4)",
        color: "white",
        zIndex: 10001,
      }}
    >
      <div className="text-[12px]">{t("common.loading")}</div>
    </div>
  );
}
