import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useVaultStore } from "../../stores/vaultStore";
import { VaultUnlockDialog } from "./VaultUnlockDialog";

export function StartupVaultUnlockGate({ children }: { children: ReactNode }) {
  const t = useT();
  const unlockMode = useAppStore((s) => s.vaultUnlockMode);
  const state = useVaultStore((s) => s.state);
  const refresh = useVaultStore((s) => s.refresh);
  const unlock = useVaultStore((s) => s.unlock);
  const checkedRef = useRef(false);
  const [promptOpen, setPromptOpen] = useState(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    if (unlockMode !== "startup") return;

    let disposed = false;
    void refresh()
      .then(() => {
        if (!disposed && useVaultStore.getState().state === "locked") {
          setPromptOpen(true);
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
    };
  }, [refresh, unlockMode]);

  useEffect(() => {
    if (state === "unlocked") setPromptOpen(false);
  }, [state]);

  return (
    <>
      {children}
      {promptOpen && state === "locked" && (
        <VaultUnlockDialog
          reason={t("vault.startupUnlockReason")}
          onCancel={() => setPromptOpen(false)}
          onSubmit={async (pw) => {
            await unlock(pw);
            setPromptOpen(false);
          }}
        />
      )}
    </>
  );
}
