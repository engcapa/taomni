import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useT } from "../../lib/i18n";
import { secretProblem } from "../../lib/mfa/base32";
import { errorText, invalidInputField } from "../../lib/mfa/format";
import { MfaImportError, isOtpauthLink, parseImportText, parseOtpauthUri, type MfaParsedItem } from "../../lib/mfa/otpauth";
import { defaultMfaInput, type MfaAccountInput, type MfaAlgorithm, type MfaKind } from "../../lib/mfa/types";
import { useMfaStore } from "../../stores/mfaStore";

const labelClass = "block text-[12px] mb-1";
const labelStyle = { color: "var(--taomni-text-muted)" };

/** Manual entry: issuer/account/secret with advanced parameters or an otpauth link. */
export function MfaSecretForm({
  onAdded,
  onCancel,
  onParsedItems,
}: {
  onAdded: (count: number) => void;
  onCancel: () => void;
  /** A pasted migration link holds several accounts; hand them to the preview. */
  onParsedItems: (items: MfaParsedItem[]) => void;
}) {
  const t = useT();
  const addAccounts = useMfaStore((s) => s.addAccounts);
  const [input, setInput] = useState<MfaAccountInput>(defaultMfaInput);
  const [uri, setUri] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const update = (patch: Partial<MfaAccountInput>) => {
    setInput((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const applyUri = (value: string) => {
    setUri(value);
    setNotice(null);
    setError(null);
    if (!value.trim() || !isOtpauthLink(value)) return;
    try {
      if (/^otpauth-migration:/i.test(value.trim())) {
        onParsedItems(parseImportText(value));
        return;
      }
      const parsed = parseOtpauthUri(value);
      setInput((current) => ({ ...parsed, group: current.group, note: current.note }));
      setAdvanced(parsed.kind !== "totp" || parsed.algorithm !== "SHA1" || parsed.digits !== 6 || parsed.period !== 30);
      setNotice(t("mfa.uriApplied"));
    } catch (err) {
      setError({ field: "uri", message: err instanceof MfaImportError ? t("mfa.imageInvalid", { error: err.message }) : errorText(err) });
    }
  };

  const localError = (): { field: string; message: string } | null => {
    if (!input.issuer.trim() && !input.accountName.trim()) return { field: "issuer", message: t("mfa.errorName") };
    const problem = secretProblem(input.secret);
    if (problem === "empty") return { field: "secret", message: t("mfa.errorSecretEmpty") };
    if (problem === "invalid") return { field: "secret", message: t("mfa.errorSecretInvalid") };
    if (problem === "short") return { field: "secret", message: t("mfa.errorSecretShort") };
    if (![6, 7, 8].includes(input.digits)) return { field: "digits", message: t("mfa.errorDigits") };
    if (input.kind === "totp" && !(input.period >= 15 && input.period <= 300)) {
      return { field: "period", message: t("mfa.errorPeriod") };
    }
    return null;
  };

  const submit = async () => {
    if (busy) return;
    const problem = localError();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const result = await addAccounts([input], false);
      onAdded(result.added.length);
    } catch (err) {
      const field = invalidInputField(err);
      if (field && /already exists/.test(field.detail)) setError({ field: "secret", message: t("mfa.errorDuplicate") });
      else setError({ field: field?.field ?? "form", message: field ? `${field.field}: ${field.detail}` : errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const invalid = (field: string) => (error?.field === field ? true : undefined);

  return (
    <form
      data-testid="mfa-secret-form"
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <label className={labelClass} style={labelStyle} htmlFor="mfa-add-uri">{t("mfa.uri")}</label>
        <input
          id="mfa-add-uri"
          data-testid="mfa-add-uri"
          className="taomni-input w-full font-mono text-[12px]"
          value={uri}
          placeholder={t("mfa.uriPlaceholder")}
          onChange={(event) => applyUri(event.target.value)}
          aria-invalid={invalid("uri")}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass} style={labelStyle} htmlFor="mfa-add-issuer">{t("mfa.issuer")}</label>
          <input id="mfa-add-issuer" ref={firstRef} data-testid="mfa-add-issuer" className="taomni-input w-full" value={input.issuer} placeholder={t("mfa.issuerPlaceholder")} onChange={(event) => update({ issuer: event.target.value })} aria-invalid={invalid("issuer")} />
        </div>
        <div>
          <label className={labelClass} style={labelStyle} htmlFor="mfa-add-account">{t("mfa.accountName")}</label>
          <input id="mfa-add-account" data-testid="mfa-add-account" className="taomni-input w-full" value={input.accountName} placeholder={t("mfa.accountPlaceholder")} onChange={(event) => update({ accountName: event.target.value })} aria-invalid={invalid("accountName")} />
        </div>
      </div>
      <div>
        <label className={labelClass} style={labelStyle} htmlFor="mfa-add-secret">{t("mfa.secret")}</label>
        <input id="mfa-add-secret" data-testid="mfa-add-secret" className="taomni-input w-full font-mono" value={input.secret} placeholder={t("mfa.secretPlaceholder")} onChange={(event) => update({ secret: event.target.value })} aria-invalid={invalid("secret")} autoComplete="off" spellCheck={false} />
        <div className="mt-0.5 text-[11px]" style={labelStyle}>{t("mfa.secretHint")}</div>
      </div>
      <div>
        <label className={labelClass} style={labelStyle} htmlFor="mfa-add-group">{t("mfa.group")}</label>
        <input id="mfa-add-group" data-testid="mfa-add-group" className="taomni-input w-full" value={input.group} placeholder={t("mfa.groupPlaceholder")} onChange={(event) => update({ group: event.target.value })} aria-invalid={invalid("group")} />
      </div>
      <button
        type="button"
        data-testid="mfa-add-advanced"
        aria-expanded={advanced}
        className="inline-flex items-center gap-1 text-[12px] hover:underline"
        style={labelStyle}
        onClick={() => setAdvanced((value) => !value)}
      >
        {advanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {t("mfa.advanced")}
      </button>
      {advanced ? (
        <div data-testid="mfa-add-advanced-panel" className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass} style={labelStyle} htmlFor="mfa-add-kind">{t("mfa.kind")}</label>
            <select id="mfa-add-kind" data-testid="mfa-add-kind" className="taomni-input w-full" value={input.kind} onChange={(event) => update({ kind: event.target.value as MfaKind })}>
              <option value="totp">{t("mfa.kindTotp")}</option>
              <option value="hotp">{t("mfa.kindHotp")}</option>
            </select>
          </div>
          <div>
            <label className={labelClass} style={labelStyle} htmlFor="mfa-add-algorithm">{t("mfa.algorithm")}</label>
            <select id="mfa-add-algorithm" data-testid="mfa-add-algorithm" className="taomni-input w-full" value={input.algorithm} onChange={(event) => update({ algorithm: event.target.value as MfaAlgorithm })}>
              <option value="SHA1">SHA1</option>
              <option value="SHA256">SHA256</option>
              <option value="SHA512">SHA512</option>
            </select>
          </div>
          <div>
            <label className={labelClass} style={labelStyle} htmlFor="mfa-add-digits">{t("mfa.digits")}</label>
            <select id="mfa-add-digits" data-testid="mfa-add-digits" className="taomni-input w-full" value={String(input.digits)} onChange={(event) => update({ digits: Number(event.target.value) })} aria-invalid={invalid("digits")}>
              <option value="6">6</option>
              <option value="7">7</option>
              <option value="8">8</option>
            </select>
          </div>
          {input.kind === "totp" ? (
            <div>
              <label className={labelClass} style={labelStyle} htmlFor="mfa-add-period">{t("mfa.period")}</label>
              <input id="mfa-add-period" data-testid="mfa-add-period" type="number" min={15} max={300} className="taomni-input w-full" value={input.period} onChange={(event) => update({ period: Number(event.target.value) })} aria-invalid={invalid("period")} />
            </div>
          ) : (
            <div>
              <label className={labelClass} style={labelStyle} htmlFor="mfa-add-counter">{t("mfa.counter")}</label>
              <input id="mfa-add-counter" data-testid="mfa-add-counter" type="number" min={0} className="taomni-input w-full" value={input.counter} onChange={(event) => update({ counter: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} />
            </div>
          )}
        </div>
      ) : null}
      {notice && !error ? <div data-testid="mfa-add-notice" className="text-[12px]" style={{ color: "var(--taomni-success-text, #2f855a)" }}>{notice}</div> : null}
      {error ? <div data-testid="mfa-add-error" role="alert" className="text-[12px]" style={{ color: "var(--taomni-error, #c33)" }}>{error.message}</div> : null}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" data-testid="mfa-add-cancel" className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]" onClick={onCancel} disabled={busy}>
          {t("mfa.cancel")}
        </button>
        <button type="submit" data-testid="mfa-add-submit" className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50" style={{ background: "var(--taomni-accent)" }} disabled={busy}>
          {t("mfa.submit")}
        </button>
      </div>
    </form>
  );
}
