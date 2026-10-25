import { useT } from "../../../lib/i18n";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getHomeDir } from "../../../lib/ipc";

export function SshKeyGenerator({ onGenerated }: { onGenerated: (path: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [comment, setComment] = useState("Taomni");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const show = async () => {
    setOpen((value) => !value);
    if (!path) {
      const home = await getHomeDir().catch(() => null);
      if (home) setPath(`${home.replace(/[\\/]$/, "")}/.ssh/taomni_ed25519`);
    }
  };
  const generate = async () => {
    setBusy(true); setMessage("");
    try {
      const result = await invoke<{ path: string; publicPath: string; fingerprint: string }>("generate_ssh_key", { path, passphrase, comment });
      setPassphrase(""); onGenerated(result.path);
      setMessage(t("sessionEditor2.keyCreated", { fingerprint: result.fingerprint, path: result.publicPath }));
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  return <div className="ml-1">
    <button data-testid="session-private-key-generate" className="taomni-btn" type="button" onClick={() => void show()} aria-expanded={open}>{t("sessionEditor2.keyGenerate")}</button>
    {open && <div data-testid="session-key-generator" className="flex flex-col gap-2 mt-2">
      <label>{t("sessionEditor2.keyPathLabel")}<input data-testid="session-key-output-path" className="taomni-input w-full" value={path} onChange={(event) => setPath(event.target.value)} disabled={busy} /></label>
      <label>{t("sessionEditor2.keyPassphrase")}<input data-testid="session-key-passphrase" type="password" className="taomni-input w-full" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} disabled={busy} /></label>
      <label>{t("sessionEditor2.keyComment")}<input data-testid="session-key-comment" className="taomni-input w-full" value={comment} onChange={(event) => setComment(event.target.value)} disabled={busy} /></label>
      <button data-testid="session-key-create" type="button" className="taomni-btn" disabled={busy || !path.trim()} onClick={() => void generate()}>{busy ? t("sessionEditor2.keyGenerating") : t("sessionEditor2.keyCreate")}</button>
      {message && <span data-testid="session-key-result" role="status">{message}</span>}
    </div>}
  </div>;
}
