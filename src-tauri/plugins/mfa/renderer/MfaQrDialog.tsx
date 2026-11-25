import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Eye, EyeOff, Link2 } from "lucide-react";
import { useT } from "../../../../src/lib/i18n";
import { writeText } from "../../../../src/lib/clipboard";
import { errorText, formatSecretKey } from "../../../../src/lib/mfa/format";
import { mfaExportUri } from "../../../../src/lib/mfa/ipc";
import { accountLabel, parseOtpauthUri } from "../../../../src/lib/mfa/otpauth";
import { qrSvgModel, type QrSvgModel } from "../../../../src/lib/mfa/qrSvg";
import type { MfaAccount } from "../../../../src/lib/mfa/types";
import { requireVaultUnlock, useVaultStore, vaultSessionIsCurrent } from "../../../../src/stores/vaultStore";

const labelStyle = { color: "var(--taomni-text-muted)" };

export interface MfaQrDialogProps {
  account: MfaAccount;
  initialAction?: "qr" | "copy-secret";
  onClose: () => void;
  onCopiedSecret?: (accountName: string) => void;
}

/**
 * Shows one account as an otpauth QR code and allows copying the secret key
 * so another authenticator app or device can use it. The secret only leaves
 * the backend after the master password is re-entered; the secret disappears
 * when the dialog closes.
 */
export function MfaQrDialog({
  account,
  initialAction = "qr",
  onClose,
  onCopiedSecret,
}: MfaQrDialogProps) {
  const t = useT();
  const name = accountLabel(account);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<QrSvgModel | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [masked, setMasked] = useState(true);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);
  const [closed, setClosed] = useState(false);
  const vaultEpoch = useVaultStore((s) => s.securityEpoch);
  const vaultReady = useVaultStore((s) => s.state === "unlocked" && !s.transitionPending && !s.requiresUnlock);
  const openedEpoch = useRef(vaultEpoch);
  const mounted = useRef(false);
  const dismissed = useRef(false);
  const request = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const passwordRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    dismissed.current = true;
    request.current += 1;
    setClosed(true);
    setUri(null);
    setSecret(null);
    setQr(null);
    setPassword("");
    onClose();
  }, [onClose]);

  const live = () => mounted.current && !dismissed.current && vaultSessionIsCurrent(openedEpoch.current);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
      timers.current.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    if (!closed && (!vaultReady || vaultEpoch !== openedEpoch.current)) close();
  }, [vaultReady, vaultEpoch, closed, close]);

  useEffect(() => {
    passwordRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    if (qr) closeRef.current?.focus();
  }, [qr]);

  const copySecretValue = async (rawSecret: string) => {
    if (!live()) return;
    try {
      await writeText(rawSecret);
      if (!live()) return;
      setCopiedSecret(true);
      timers.current.push(setTimeout(() => { if (live()) setCopiedSecret(false); }, 2000));
      onCopiedSecret?.(name);
    } catch {
      // ignore
    }
  };

  const copyUriValue = async (rawUri: string) => {
    if (!live()) return;
    try {
      await writeText(rawUri);
      if (!live()) return;
      setCopiedUri(true);
      timers.current.push(setTimeout(() => { if (live()) setCopiedUri(false); }, 2000));
    } catch {
      // ignore
    }
  };

  const reveal = async () => {
    if (busy || !live()) return;
    if (!password.trim()) {
      setError(t("mfa.qrPasswordRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    const token = ++request.current;
    try {
      const exportedUri = await mfaExportUri(account.id, password);
      if (!live() || token !== request.current) return;
      let rawSecret = "";
      try {
        const parsed = parseOtpauthUri(exportedUri);
        rawSecret = parsed.secret;
      } catch {
        // fallback
      }
      const model = await qrSvgModel(exportedUri);
      if (!live() || token !== request.current) return;
      setUri(exportedUri);
      setSecret(rawSecret);
      setQr(model);
      setPassword("");

      if (initialAction === "copy-secret" && rawSecret) {
        await copySecretValue(rawSecret);
      }
    } catch (err) {
      if (!live() || token !== request.current) return;
      const text = errorText(err);
      if (text.startsWith("VAULT_LOCKED")) requireVaultUnlock();
      else if (text.startsWith("VAULT_BAD_PASSWORD")) setError(t("mfa.qrBadPassword"));
      else if (text.startsWith("VAULT_PASSWORD_REQUIRED")) setError(t("mfa.qrPasswordRequired"));
      else setError(t("mfa.errorPrefix", { error: text }));
    } finally {
      if (live() && token === request.current) setBusy(false);
    }
  };

  if (closed || !vaultReady || vaultEpoch !== openedEpoch.current) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }} onClick={close}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t("mfa.qrTitle", { name })}
        data-testid="mfa-qr-dialog"
        data-state={qr ? "shown" : "locked"}
        className="w-[420px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-32px)] overflow-y-auto space-y-3.5 rounded-xl p-5 shadow-2xl"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)", color: "var(--taomni-text)" }}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void reveal();
        }}
      >
        <div className="text-ui-title font-semibold tracking-tight">{t("mfa.qrTitle", { name })}</div>
        <div className="flex gap-2 rounded-md p-2.5 text-ui-body" style={{ background: "rgba(234, 179, 8, 0.08)", color: "var(--taomni-warning-text, #b7791f)", border: "1px solid rgba(234, 179, 8, 0.2)" }}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("mfa.qrWarning")}</span>
        </div>
        {qr ? (
          <div className="flex flex-col items-center gap-3 pt-1">
            <div className="p-2.5 rounded-lg bg-white shadow-sm border" style={{ borderColor: "var(--taomni-divider)" }}>
              <svg
                data-testid="mfa-qr-image"
                data-modules={qr.size}
                role="img"
                aria-label={t("mfa.qrImageLabel", { name })}
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                width={220}
                height={220}
                shapeRendering="crispEdges"
                className="rounded"
              >
                <rect width={qr.size} height={qr.size} fill="#ffffff" />
                <path d={qr.path} fill="#000000" />
              </svg>
            </div>
            <div className="text-ui-body text-center" style={labelStyle}>
              {account.kind === "hotp" ? t("mfa.qrHotpHint") : t("mfa.qrScanHint")}
            </div>

            {secret ? (
              <div className="w-full space-y-1.5 rounded-lg border p-3" style={{ background: "var(--taomni-card-bg)", borderColor: "var(--taomni-card-border)" }}>
                <div className="flex items-center justify-between">
                  <span className="text-ui-small font-medium uppercase tracking-wider" style={labelStyle}>
                    {t("mfa.secretKey")}
                  </span>
                  <button
                    type="button"
                    data-testid="mfa-qr-toggle-secret"
                    aria-label={masked ? t("mfa.showSecret") : t("mfa.hideSecret")}
                    title={masked ? t("mfa.showSecret") : t("mfa.hideSecret")}
                    className="rounded p-1 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors"
                    onClick={() => setMasked((m) => !m)}
                  >
                    {masked ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <div
                  data-testid="mfa-qr-secret"
                  className="font-mono text-ui-body font-bold tracking-wider select-all break-all px-2 py-1.5 rounded"
                  style={{ background: "var(--taomni-hover)", color: "var(--taomni-accent)" }}
                >
                  {masked ? "•••• •••• •••• ••••" : formatSecretKey(secret)}
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    data-testid="mfa-qr-copy-secret"
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded border px-2.5 py-1.5 text-ui-body font-medium transition-colors hover:bg-[var(--taomni-hover)]"
                    style={{ borderColor: "var(--taomni-input-border)" }}
                    onClick={() => void copySecretValue(secret)}
                  >
                    {copiedSecret ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copiedSecret ? t("mfa.copiedShort") : t("mfa.copySecret")}</span>
                  </button>
                  {uri ? (
                    <button
                      type="button"
                      data-testid="mfa-qr-copy-uri"
                      className="inline-flex items-center justify-center gap-1.5 rounded border px-2.5 py-1.5 text-ui-body font-medium transition-colors hover:bg-[var(--taomni-hover)]"
                      style={{ borderColor: "var(--taomni-input-border)" }}
                      title={t("mfa.copyUri")}
                      onClick={() => void copyUriValue(uri)}
                    >
                      {copiedUri ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Link2 className="h-3.5 w-3.5" />}
                      <span>{copiedUri ? t("mfa.copiedShort") : t("mfa.copyUri")}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <label className="block text-ui-body" style={labelStyle}>
            {t("mfa.qrPassword")}
            <input
              ref={passwordRef}
              type="password"
              data-testid="mfa-qr-password"
              className="taomni-input mt-1.5 w-full h-8 text-ui-body"
              value={password}
              autoComplete="current-password"
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
          </label>
        )}
        {error ? <div data-testid="mfa-qr-error" role="alert" className="text-ui-body" style={{ color: "var(--taomni-error, #c33)" }}>{error}</div> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button ref={closeRef} type="button" data-testid="mfa-qr-close" className="px-3.5 py-1.5 text-ui-body rounded-md border font-medium hover:bg-[var(--taomni-hover)] transition-colors" style={{ borderColor: "var(--taomni-input-border)" }} onClick={close}>
            {t("mfa.close")}
          </button>
          {qr ? null : (
            <button type="submit" data-testid="mfa-qr-reveal" className="px-3.5 py-1.5 text-ui-body rounded-md text-white font-medium disabled:opacity-50 transition-colors" style={{ background: "var(--taomni-accent)" }} disabled={busy}>
              {t("mfa.qrReveal")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
