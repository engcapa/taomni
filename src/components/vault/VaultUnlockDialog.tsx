import { useId, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { Modal } from "../ui/Modal";

export interface VaultUnlockDialogProps {
  onCancel?: () => void;
  onSubmit: (masterPassword: string) => Promise<void>;
  /** Optional context line shown below the title (e.g. why we're prompting). */
  reason?: string;
  /** When false, the dialog cannot be dismissed without unlocking. */
  cancellable?: boolean;
  /** Retained for caller compatibility; native dialog top layer sits above all app chrome. */
  zIndex?: number;
}

export function VaultUnlockDialog({
  onCancel,
  onSubmit,
  reason,
  cancellable = true,
  zIndex: _zIndex,
}: VaultUnlockDialogProps) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pwId = useId();
  const errorId = useId();
  const t = useT();

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
      queueMicrotask(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("vault.unlockTitle")}
      testId="vault-unlock-dialog"
      initialFocus='[data-testid="vault-unlock-pw"]'
      dismissOnBackdrop={false}
      onCancel={() => {
        if (cancellable && !busy) onCancel?.();
      }}
      footer={
        <>
          {cancellable && (
            <button
              type="button"
              data-testid="vault-unlock-cancel"
              className="taomni-btn"
              onClick={onCancel}
              disabled={busy}
            >
              {t("vault.cancel")}
            </button>
          )}
          <button
            type="button"
            data-testid="vault-unlock-confirm"
            className="taomni-btn"
            data-primary="true"
            aria-busy={busy || undefined}
            onClick={() => void handleSubmit()}
            disabled={!valid || busy}
          >
            {busy ? t("vault.unlocking") : t("vault.unlock")}
          </button>
        </>
      }
    >
      <div className="grid gap-2">
        {reason && (
          <p
            className="text-ui-body text-[var(--taomni-text-muted)]"
            data-testid="vault-unlock-reason"
          >
            {reason}
          </p>
        )}

        <label
          htmlFor={pwId}
          className="block text-ui-body text-[var(--taomni-text-muted)]"
        >
          {t("vault.masterPassword")}
        </label>
        <input
          id={pwId}
          ref={inputRef}
          data-testid="vault-unlock-pw"
          type="password"
          value={pw}
          readOnly={busy}
          onChange={(event) => setPw(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          className="taomni-input w-full"
          autoComplete="current-password"
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : undefined}
        />

        {error && (
          <div
            id={errorId}
            role="alert"
            className="text-ui-body text-ui-danger"
            data-testid="vault-unlock-error"
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
