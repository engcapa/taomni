import { useState } from "react";
import { useT } from "../../lib/i18n";
import { sockscapRecover } from "../../lib/sockscap";
import { isRootRequiredError, isSudoAuthenticationError } from "../../lib/sockscap/recoveryErrors";
import { useRecoveryStatus } from "../../lib/sockscap/useRecoveryStatus";
import { ElevationPasswordPrompt } from "../ElevationPasswordPrompt";

export function ModuleSocksCapRecovery() {
  const t = useT();
  const recovery = useRecoveryStatus();
  const [busy, setBusy] = useState(false);
  const [requestPassword, setRequestPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recover(password?: string) {
    setBusy(true);
    setError(null);
    try {
      await sockscapRecover(password);
      setRequestPassword(false);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!password && isRootRequiredError(message)) {
        setRequestPassword(true);
      } else if (password && isSudoAuthenticationError(message)) {
        setError(t("sockscap.rootPromptIncorrectPassword"));
      } else {
        setRequestPassword(false);
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!recovery) return null;
  return (
    <div data-testid="module-sockscap-recovery" className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs" role="alert">
      <p className="font-semibold">{t("settings.moduleStoreSocksCapRecovery")}</p>
      <p className="mt-1 break-words">{recovery.message}</p>
      {error && !requestPassword ? <p className="mt-1 break-words">{error}</p> : null}
      <button type="button" data-testid="module-sockscap-recover" className="taomni-btn mt-2 h-7 px-2.5"
        onClick={() => void recover()} disabled={busy}>
        {t("sockscap.recover")}
      </button>
      {requestPassword && (
        <ElevationPasswordPrompt subtitle={t("sockscap.recoverHint")} onSubmit={recover}
          onCancel={() => { setRequestPassword(false); setError(null); }} error={error} busy={busy} />
      )}
    </div>
  );
}
