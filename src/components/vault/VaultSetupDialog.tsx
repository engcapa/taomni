import { useId, useState } from "react";
import { useT } from "../../lib/i18n";
import { ConfirmDialog } from "../sidebar/ConfirmDialog";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { usePendingAction } from "../ui/usePendingAction";

export interface VaultSetupDialogProps {
  onCancel: () => void;
  onSubmit: (masterPassword: string) => Promise<void>;
}

export function VaultSetupDialog({ onCancel, onSubmit }: VaultSetupDialogProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const t = useT();
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirmation.length > 0 && password !== confirmation;
  const valid = password.length >= 8 && password === confirmation;
  const { busy, run } = usePendingAction(async () => {
    setError(null);
    try {
      await onSubmit(password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  });

  function cancel() {
    if (busy) return;
    if (password || confirmation) setDiscarding(true);
    else onCancel();
  }

  return <>
    <Modal title={t("vault.setupTitleSet")} testId="vault-setup-dialog" initialFocus="input"
      onCancel={cancel} footer={<>
        <Button onClick={cancel} disabled={busy} data-testid="vault-setup-cancel">{t("vault.cancel")}</Button>
        <Button type="submit" form={id} variant="primary" busy={busy} disabled={!valid}
          data-testid="vault-setup-confirm">{busy ? t("vault.settingUp") : t("vault.createVault")}</Button>
      </>}>
      <form id={id} className="grid gap-2" aria-busy={busy} onSubmit={(event) => {
        event.preventDefault();
        if (valid && !discarding) void run();
      }}>
        <p>{t("vault.setupDescription")}</p>
        <label htmlFor={id + "-password"}>{t("vault.masterPasswordHint")}</label>
        <input id={id + "-password"} data-testid="vault-setup-pw1" type="password" autoComplete="new-password"
          className="taomni-input w-full" value={password} readOnly={busy}
          onChange={(event) => setPassword(event.target.value)} aria-invalid={tooShort || undefined}
          aria-describedby={tooShort ? id + "-length" : undefined} />
        {tooShort && <p id={id + "-length"} data-testid="vault-setup-too-short" className="text-[var(--taomni-danger-text)]">
          {t("vault.tooShort")}
        </p>}
        <label htmlFor={id + "-confirm"}>{t("vault.confirmLabel")}</label>
        <input id={id + "-confirm"} data-testid="vault-setup-pw2" type="password" autoComplete="new-password"
          className="taomni-input w-full" value={confirmation} readOnly={busy}
          onChange={(event) => setConfirmation(event.target.value)} aria-invalid={mismatch || undefined}
          aria-describedby={mismatch ? id + "-mismatch" : undefined} />
        {mismatch && <p id={id + "-mismatch"} data-testid="vault-setup-mismatch" className="text-[var(--taomni-danger-text)]">
          {t("vault.mismatchLong")}
        </p>}
        {error && <p role="alert" data-testid="vault-setup-error" className="text-[var(--taomni-danger-text)]">{error}</p>}
      </form>
    </Modal>
    {discarding && <ConfirmDialog title={t("vault.discardSetupTitle")} message={t("vault.discardSetupMessage")}
      danger confirmLabel={t("vault.discardSetupAction")} cancelLabel={t("vault.continueSetup")}
      onCancel={() => setDiscarding(false)} onConfirm={onCancel} />}
  </>;
}
