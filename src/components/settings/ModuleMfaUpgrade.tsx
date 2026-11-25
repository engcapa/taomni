import { open } from "@tauri-apps/plugin-dialog";
import { FileUp, RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useT } from "../../lib/i18n";
import { getMfaMigrationResult, migrateMfaAndRestart } from "../../lib/ipc/plugin";

export function ModuleMfaUpgrade({ eligible, installed = false }: { eligible: boolean; installed?: boolean }) {
  const t = useT();
  const archiveId = useId();
  const signatureId = useId();
  const [visible, setVisible] = useState(false);
  const [archive, setArchive] = useState("");
  const [signature, setSignature] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"complete" | "failed" | null>(null);
  const password = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const packageReady = installed || Boolean(archive.trim() && signature.trim());

  useEffect(() => {
    let mounted = true;
    void Promise.resolve().then(getMfaMigrationResult).then((value) => {
      if (mounted) setResult(value);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  async function pick(extension: string, label: string, select: (value: string) => void) {
    try {
      const path = await open({ title: label, filters: [{ name: label, extensions: [extension] }] });
      if (typeof path === "string") select(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function cancel() {
    setArchive("");
    setSignature("");
    setHasPassword(false);
    setVisible(false);
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = password.current;
    if (pending.current || !packageReady || !input?.value) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const masterPassword = input.value;
    input.value = "";
    setHasPassword(false);
    try {
      await migrateMfaAndRestart(installed ? undefined : archive, installed ? undefined : signature, masterPassword);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message === "VAULT_BAD_PASSWORD" ? t("settings.moduleUpgradeMfaPasswordError") : message);
      pending.current = false;
      setBusy(false);
      input.focus();
    }
  }

  if (!eligible && !result) return null;

  return <div className="mb-3 space-y-2">
    {result && <p data-testid="module-upgrade-mfa-result" data-state={result} role={result === "failed" ? "alert" : "status"} className="break-words text-xs">
      {t(result === "complete" ? "settings.moduleUpgradeMfaComplete" : "settings.moduleUpgradeMfaFailed")}
    </p>}
    {eligible && !visible && <button type="button" data-testid="module-upgrade-mfa-open" className="taomni-btn inline-flex items-center gap-1 px-2.5 py-1 text-xs" onClick={() => setVisible(true)}>
      <FileUp className="h-3.5 w-3.5" /> {t(installed ? "settings.moduleUpgradeMfaInstalled" : "settings.moduleUpgradeMfaOpen")}
    </button>}
    {eligible && visible && <form data-testid="module-upgrade-mfa-form" onSubmit={(event) => void submit(event)} className="space-y-2 border-t border-[var(--taomni-divider)] pt-2 text-xs">
      <fieldset disabled={busy} className="space-y-2">
        {!installed && <>
          <div>
            <label htmlFor={archiveId}>{t("settings.moduleUpgradeMfaArchive")}</label>
            <span className="mt-1 flex gap-1.5">
              <input id={archiveId} className="taomni-input min-w-0 flex-1" value={archive} onChange={(event) => setArchive(event.target.value)} data-testid="module-upgrade-mfa-archive" />
              <button type="button" className="taomni-btn shrink-0 px-2" data-testid="module-upgrade-mfa-choose-archive" aria-label={t("settings.moduleUpgradeMfaArchive")}
                onClick={() => void pick("taomni-plugin", t("settings.moduleUpgradeMfaArchive"), setArchive)}><FileUp className="h-3.5 w-3.5" /></button>
            </span>
          </div>
          <div>
            <label htmlFor={signatureId}>{t("settings.moduleUpgradeMfaSignature")}</label>
            <span className="mt-1 flex gap-1.5">
              <input id={signatureId} className="taomni-input min-w-0 flex-1" value={signature} onChange={(event) => setSignature(event.target.value)} data-testid="module-upgrade-mfa-signature" />
              <button type="button" className="taomni-btn shrink-0 px-2" data-testid="module-upgrade-mfa-choose-signature" aria-label={t("settings.moduleUpgradeMfaSignature")}
                onClick={() => void pick("minisig", t("settings.moduleUpgradeMfaSignature"), setSignature)}><FileUp className="h-3.5 w-3.5" /></button>
            </span>
          </div>
        </>}
        <label className="block">
          {t("settings.moduleUpgradeMfaPassword")}
          <input ref={password} className="taomni-input mt-1 block w-full" type="password" autoComplete="current-password"
            onInput={(event) => setHasPassword(event.currentTarget.value.length > 0)} data-testid="module-upgrade-mfa-password" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" data-testid="module-upgrade-mfa-submit" className="taomni-btn inline-flex items-center gap-1 px-2.5 py-1"
            disabled={!packageReady || !hasPassword}>
            <RotateCcw className="h-3.5 w-3.5" /> {t("settings.moduleUpgradeMfaRestart")}
          </button>
          <button type="button" data-testid="module-upgrade-mfa-cancel" className="taomni-btn px-2.5 py-1" onClick={cancel}>{t("common.cancel")}</button>
        </div>
      </fieldset>
      {busy && <p role="status">{t("settings.moduleUpgradeWorking")}</p>}
      {error && <p role="alert" data-testid="module-upgrade-mfa-error" className="break-words text-[var(--taomni-error)]">{error}</p>}
    </form>}
  </div>;
}
