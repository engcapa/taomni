import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";

export interface VaultUnlockDialogProps {
  onCancel: () => void;
  onSubmit: (masterPassword: string) => Promise<void>;
  /** Optional context line shown below the title (e.g. why we're prompting). */
  reason?: string;
}

export function VaultUnlockDialog({ onCancel, onSubmit, reason }: VaultUnlockDialogProps) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const valid = pw.length > 0;

  const handleSubmit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes("VAULT_BAD_PASSWORD") ? t("vault.incorrectPassword") : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter") {
      const target = event.target as HTMLElement;
      if (target.tagName !== "BUTTON") {
        event.preventDefault();
        void handleSubmit();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label={t("vault.unlockTitle")}
        aria-modal="true"
        data-testid="vault-unlock-dialog"
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-1">{t("vault.unlockTitle")}</div>
        {reason && (
          <div
            className="text-[12px] mb-3"
            style={{ color: "var(--moba-text-muted)" }}
            data-testid="vault-unlock-reason"
          >
            {reason}
          </div>
        )}

        <label className="block text-[12px] mb-1" style={{ color: "var(--moba-text-muted)" }}>
          {t("vault.masterPassword")}
        </label>
        <input
          ref={inputRef}
          data-testid="vault-unlock-pw"
          type="password"
          value={pw}
          onChange={(event) => setPw(event.target.value)}
          className="moba-input w-full"
          autoComplete="current-password"
        />

        {error && (
          <div
            className="mt-2 text-[12px]"
            style={{ color: "var(--moba-error, #c33)" }}
            data-testid="vault-unlock-error"
          >
            {error}
          </div>
        )}

        <div className="flex gap-2 justify-end mt-4">
          <button
            type="button"
            data-testid="vault-unlock-cancel"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
            onClick={onCancel}
            disabled={busy}
          >
            {t("vault.cancel")}
          </button>
          <button
            type="button"
            data-testid="vault-unlock-confirm"
            className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
            style={{ background: "var(--moba-accent)" }}
            onClick={() => void handleSubmit()}
            disabled={!valid || busy}
          >
            {busy ? t("vault.unlocking") : t("vault.unlock")}
          </button>
        </div>
      </div>
    </div>
  );
}
