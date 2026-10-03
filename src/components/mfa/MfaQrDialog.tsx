import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useT } from "../../lib/i18n";
import { errorText } from "../../lib/mfa/format";
import { mfaExportUri } from "../../lib/mfa/ipc";
import { accountLabel } from "../../lib/mfa/otpauth";
import { qrSvgModel, type QrSvgModel } from "../../lib/mfa/qrSvg";
import type { MfaAccount } from "../../lib/mfa/types";

const labelStyle = { color: "var(--taomni-text-muted)" };

/**
 * Shows one account as an otpauth QR code so another authenticator app can
 * scan it. The secret only leaves the backend after the master password is
 * re-entered; the code disappears when the dialog closes.
 */
export function MfaQrDialog({ account, onClose }: { account: MfaAccount; onClose: () => void }) {
  const t = useT();
  const name = accountLabel(account);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<QrSvgModel | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    passwordRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (qr) closeRef.current?.focus();
  }, [qr]);

  const reveal = async () => {
    if (busy) return;
    if (!password.trim()) {
      setError(t("mfa.qrPasswordRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setQr(await qrSvgModel(await mfaExportUri(account.id, password)));
      setPassword("");
    } catch (err) {
      const text = errorText(err);
      if (text.startsWith("VAULT_BAD_PASSWORD")) setError(t("mfa.qrBadPassword"));
      else if (text.startsWith("VAULT_PASSWORD_REQUIRED")) setError(t("mfa.qrPasswordRequired"));
      else setError(t("mfa.errorPrefix", { error: text }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t("mfa.qrTitle", { name })}
        data-testid="mfa-qr-dialog"
        data-state={qr ? "shown" : "locked"}
        className="w-[380px] max-w-[calc(100vw-24px)] space-y-3 rounded p-4 shadow-lg"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)", color: "var(--taomni-text)" }}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void reveal();
        }}
      >
        <div className="text-sm font-semibold">{t("mfa.qrTitle", { name })}</div>
        <div className="flex gap-2 text-[12px]" style={{ color: "var(--taomni-warning-text, #b7791f)" }}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("mfa.qrWarning")}</span>
        </div>
        {qr ? (
          <div className="flex flex-col items-center gap-2">
            <svg
              data-testid="mfa-qr-image"
              data-modules={qr.size}
              role="img"
              aria-label={t("mfa.qrImageLabel", { name })}
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              width={256}
              height={256}
              shapeRendering="crispEdges"
              className="rounded"
            >
              <rect width={qr.size} height={qr.size} fill="#ffffff" />
              <path d={qr.path} fill="#000000" />
            </svg>
            <div className="text-[12px]" style={labelStyle}>
              {account.kind === "hotp" ? t("mfa.qrHotpHint") : t("mfa.qrScanHint")}
            </div>
          </div>
        ) : (
          <label className="block text-[12px]" style={labelStyle}>
            {t("mfa.qrPassword")}
            <input
              ref={passwordRef}
              type="password"
              data-testid="mfa-qr-password"
              className="taomni-input mt-1 w-full"
              value={password}
              autoComplete="current-password"
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
          </label>
        )}
        {error ? <div data-testid="mfa-qr-error" role="alert" className="text-[12px]" style={{ color: "var(--taomni-error, #c33)" }}>{error}</div> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button ref={closeRef} type="button" data-testid="mfa-qr-close" className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]" onClick={onClose}>
            {t("mfa.close")}
          </button>
          {qr ? null : (
            <button type="submit" data-testid="mfa-qr-reveal" className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50" style={{ background: "var(--taomni-accent)" }} disabled={busy}>
              {t("mfa.qrReveal")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
