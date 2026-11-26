import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { Modal } from "../ui/Modal";

export interface ExternalVaultUnlockDialogProps {
  /** Source tool name, e.g. "Tabby". Drives the dialog title. */
  toolName: string;
  /** Optional title override for tools that do not call this a vault unlock. */
  title?: string;
  /** Body copy shown above the password field. */
  description: string;
  /** Optional password-label override, e.g. "SecureCRT passphrase". */
  passwordLabel?: string;
  /** Resolves on success; throw to display an error and stay open. */
  onSubmit: (masterPassword: string) => Promise<void>;
  onSkip: () => void;
  /** Optional message rendered after a failed attempt (e.g. "Incorrect password"). */
  errorMessage?: string | null;
}

/**
 * Generic, prop-driven master-password prompt for unlocking a third-party
 * tool's encrypted secret vault during session import. Distinct from
 * `VaultUnlockDialog` (which unlocks Taomni's own vault) so users can tell
 * the two prompts apart.
 */
export function ExternalVaultUnlockDialog({
  toolName,
  title,
  description,
  passwordLabel,
  onSubmit,
  onSkip,
  errorMessage,
}: ExternalVaultUnlockDialogProps) {
  const t = useT();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pwId = useId();
  const errorId = useId();

  useEffect(() => {
    if (errorMessage) setLocalError(errorMessage);
  }, [errorMessage]);

  const valid = pw.length > 0;

  const handleSubmit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setLocalError(null);
    try {
      await onSubmit(pw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLocalError(msg);
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
      title={title ?? t("externalVault.title", { tool: toolName })}
      testId="external-vault-unlock-dialog"
      initialFocus='[data-testid="external-vault-unlock-pw"]'
      dismissOnBackdrop={false}
      onCancel={() => {
        if (!busy) onSkip();
      }}
      footer={
        <>
          <button
            type="button"
            data-testid="external-vault-unlock-skip"
            className="taomni-btn"
            onClick={onSkip}
            disabled={busy}
          >
            {t("externalVault.skip")}
          </button>
          <button
            type="button"
            data-testid="external-vault-unlock-confirm"
            className="taomni-btn"
            data-primary="true"
            aria-busy={busy || undefined}
            onClick={() => void handleSubmit()}
            disabled={!valid || busy}
          >
            {busy ? t("externalVault.unlocking") : t("externalVault.unlock")}
          </button>
        </>
      }
    >
      <div className="grid gap-2">
        <p
          className="text-ui-body text-[var(--taomni-text-muted)]"
          data-testid="external-vault-unlock-description"
        >
          {description}
        </p>

        <label
          htmlFor={pwId}
          className="block text-ui-body text-[var(--taomni-text-muted)]"
        >
          {passwordLabel ?? t("externalVault.masterPasswordLabel", { tool: toolName })}
        </label>
        <input
          id={pwId}
          ref={inputRef}
          data-testid="external-vault-unlock-pw"
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
          autoComplete="off"
          aria-invalid={localError ? "true" : undefined}
          aria-describedby={localError ? errorId : undefined}
        />

        {localError && (
          <div
            id={errorId}
            role="alert"
            className="text-ui-body text-ui-danger"
            data-testid="external-vault-unlock-error"
          >
            {localError}
          </div>
        )}
      </div>
    </Modal>
  );
}
