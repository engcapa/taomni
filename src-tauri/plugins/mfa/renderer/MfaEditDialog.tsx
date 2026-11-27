import { useId, useRef, useState } from "react";
import { useT } from "../../../../src/lib/i18n";
import { errorText } from "../../../../src/lib/mfa/format";
import type { MfaAccount } from "../../../../src/lib/mfa/types";
import { useMfaStore } from "../../../../src/stores/mfaStore";

import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button";
import { ModalSurface } from "../../../crates/taomni-plugin-api/frontend/ui/ModalSurface";
import { usePendingAction } from "../../../crates/taomni-plugin-api/frontend/ui/usePendingAction";
import { ConfirmDialog } from "../../../crates/taomni-plugin-api/frontend/ui/ConfirmDialog";

const labelStyle = { color: "var(--taomni-text-muted)" };

/** Edit issuer, account, group and note; the secret and OTP parameters are fixed. */
export function MfaEditDialog({
  account,
  groups,
  returnFocus,
  onClose,
  onSaved,
}: {
  account: MfaAccount;
  groups: string[];
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onSaved: (account: MfaAccount) => void;
}) {
  const t = useT();
  const updateAccount = useMfaStore((s) => s.updateAccount);
  const [issuer, setIssuer] = useState(account.issuer);
  const [accountName, setAccountName] = useState(account.accountName);
  const [group, setGroup] = useState(account.group);
  const [note, setNote] = useState(account.note);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const invalidName = !issuer.trim() && !accountName.trim();
  const dirty = issuer !== account.issuer || accountName !== account.accountName || group !== account.group || note !== account.note;
  const { busy, run } = usePendingAction(async () => {
    if (invalidName) {
      setError(t("mfa.errorName"));
      firstRef.current?.focus();
      return;
    }
    setError(null);
    try {
      onSaved(await updateAccount(account.id, { issuer, accountName, group, note, pinned: account.pinned }));
    } catch (err) {
      setError(errorText(err));
    }
  });

  function cancel() {
    if (busy) return;
    if (dirty) setDiscarding(true);
    else onClose();
  }

  return <>
    <ModalSurface className="taomni-modal" aria-labelledby={id + "-title"} data-testid="mfa-edit-dialog"
      initialFocus='[data-testid="mfa-edit-issuer"]' returnFocus={returnFocus} onCancel={cancel}>
      <h2 id={id + "-title"}>{t("mfa.editTitle")}</h2>
      <form id={id} className="taomni-modal-body space-y-2" aria-busy={busy} onSubmit={(event) => {
        event.preventDefault();
        if (!discarding) void run();
      }}>
        {error && <p id={id + "-error"} data-testid="mfa-edit-error" role="alert" className="text-ui-danger">{error}</p>}
        <label className="block text-ui-body" style={labelStyle}>
          {t("mfa.issuer")}
          <input ref={firstRef} aria-invalid={!!error && invalidName || undefined}
            aria-describedby={error && invalidName ? id + "-error" : undefined} data-testid="mfa-edit-issuer" readOnly={busy} className="taomni-input mt-1 w-full" value={issuer} onChange={(event) => setIssuer(event.target.value)} />
        </label>
        <label className="block text-ui-body" style={labelStyle}>
          {t("mfa.accountName")}
          <input data-testid="mfa-edit-account" readOnly={busy} className="taomni-input mt-1 w-full" value={accountName} onChange={(event) => setAccountName(event.target.value)} />
        </label>
        <label className="block text-ui-body" style={labelStyle}>
          {t("mfa.group")}
          <input data-testid="mfa-edit-group" readOnly={busy} className="taomni-input mt-1 w-full" list={id + "-groups"} value={group} placeholder={t("mfa.groupPlaceholder")} onChange={(event) => setGroup(event.target.value)} />
          <datalist id={id + "-groups"}>
            {groups.map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
        </label>
        <label className="block text-ui-body" style={labelStyle}>
          {t("mfa.note")}
          <textarea data-testid="mfa-edit-note" readOnly={busy} className="taomni-input mt-1 w-full" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
      </form>
      <footer className="taomni-modal-footer">
        <Button data-testid="mfa-edit-cancel" onClick={cancel} disabled={busy}>{t("mfa.cancel")}</Button>
        <Button form={id} type="submit" data-testid="mfa-edit-save" variant="primary" busy={busy}>
          {busy ? t("mfa.savingEdit") : t("mfa.save")}
        </Button>
      </footer>
    </ModalSurface>
    {discarding && <ConfirmDialog title={t("mfa.discardEditTitle")} message={t("mfa.discardEditMessage")}
      danger confirmLabel={t("mfa.discardEdit")} cancelLabel={t("mfa.keepEditing")}
      onCancel={() => setDiscarding(false)} onConfirm={onClose} />}
  </>;
}
