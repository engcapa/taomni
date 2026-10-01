import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { errorText } from "../../lib/mfa/format";
import type { MfaAccount } from "../../lib/mfa/types";
import { useMfaStore } from "../../stores/mfaStore";

const labelStyle = { color: "var(--taomni-text-muted)" };

/** Edit issuer, account, group and note; the secret and OTP parameters are fixed. */
export function MfaEditDialog({
  account,
  groups,
  onClose,
  onSaved,
}: {
  account: MfaAccount;
  groups: string[];
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
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (busy) return;
    if (!issuer.trim() && !accountName.trim()) {
      setError(t("mfa.errorName"));
      return;
    }
    setBusy(true);
    try {
      onSaved(await updateAccount(account.id, { issuer, accountName, group, note, pinned: account.pinned }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t("mfa.editTitle")}
        data-testid="mfa-edit-dialog"
        className="w-[420px] max-w-[calc(100vw-24px)] space-y-2 rounded p-4 shadow-lg"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)", color: "var(--taomni-text)" }}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="text-sm font-semibold">{t("mfa.editTitle")}</div>
        <label className="block text-[12px]" style={labelStyle}>
          {t("mfa.issuer")}
          <input ref={firstRef} data-testid="mfa-edit-issuer" className="taomni-input mt-1 w-full" value={issuer} onChange={(event) => setIssuer(event.target.value)} />
        </label>
        <label className="block text-[12px]" style={labelStyle}>
          {t("mfa.accountName")}
          <input data-testid="mfa-edit-account" className="taomni-input mt-1 w-full" value={accountName} onChange={(event) => setAccountName(event.target.value)} />
        </label>
        <label className="block text-[12px]" style={labelStyle}>
          {t("mfa.group")}
          <input data-testid="mfa-edit-group" className="taomni-input mt-1 w-full" list="mfa-edit-groups" value={group} placeholder={t("mfa.groupPlaceholder")} onChange={(event) => setGroup(event.target.value)} />
          <datalist id="mfa-edit-groups">
            {groups.map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
        </label>
        <label className="block text-[12px]" style={labelStyle}>
          {t("mfa.note")}
          <textarea data-testid="mfa-edit-note" className="taomni-input mt-1 w-full" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        {error ? <div data-testid="mfa-edit-error" role="alert" className="text-[12px]" style={{ color: "var(--taomni-error, #c33)" }}>{error}</div> : null}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" data-testid="mfa-edit-cancel" className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]" onClick={onClose} disabled={busy}>
            {t("mfa.cancel")}
          </button>
          <button type="submit" data-testid="mfa-edit-save" className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50" style={{ background: "var(--taomni-accent)" }} disabled={busy}>
            {t("mfa.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
