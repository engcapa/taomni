import { useT } from "../../lib/i18n";
import { VaultGate } from "../vault/VaultGate";
import { MfaPanel } from "./MfaPanel";

/**
 * MFA authenticator tab. Secrets are sealed with a data key held in the
 * credential vault, so the panel only mounts while the vault is unlocked; the
 * gate offers setup (empty vault) or unlock and re-appears if the vault locks.
 */
export function MfaTab({ onStatusMessage }: { onStatusMessage?: (message: string) => void }) {
  const t = useT();
  return (
    <div data-testid="mfa-tab" className="absolute inset-0 flex flex-col">
      <VaultGate lockedTitle={t("mfa.lockedTitle")} lockedHint={t("mfa.lockedHint")} reason={t("mfa.unlockReason")}>
        <MfaPanel onStatusMessage={onStatusMessage} />
      </VaultGate>
    </div>
  );
}
