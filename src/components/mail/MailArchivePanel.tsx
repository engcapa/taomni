import { useCallback, useEffect, useRef, useState } from "react";
import type { MailTabInfo } from "../../types";
import { mailArchivePause, mailArchiveStart, mailArchiveStatus, type MailArchiveStatus } from "../../lib/mail";
import { folderLabel } from "../../lib/mailFolders";
import { MailArchiveDialog } from "./MailArchiveDialog";

const activePhases = new Set(["connecting", "headers", "downloading", "verifying", "pausing", "shared"]);
const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`;

export function MailArchivePanel({ info }: { info: MailTabInfo }) {
  const [status, setStatus] = useState<MailArchiveStatus | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const config = useRef(info);
  config.current = info;
  const identity = JSON.stringify(info);
  const refresh = useCallback(async () => setStatus(await mailArchiveStatus(info.sessionId)), [info.sessionId]);
  useEffect(() => {
    let alive = true;
    let pending = false;
    let nextScan = 0;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        if (Date.now() >= nextScan) {
          nextScan = Date.now() + 60_000;
          await mailArchiveStart(config.current);
        }
        const value = await mailArchiveStatus(info.sessionId);
        if (alive) setStatus(value);
      } catch (e) { if (alive) setError(String(e)); }
      finally { pending = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    // The backend owns the download. Unmounting must not cancel it.
    return () => { alive = false; window.clearInterval(timer); };
  }, [identity, info.sessionId, info.incoming]);
  const [busy, setBusy] = useState(false);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const running = activePhases.has(status?.phase || "");
  const progress = <span data-testid="mail-storage-progress" role="status">
    Full mail: {status?.phase === "shared" ? "syncing in another instance" : status?.phase || "connecting"}{status?.folder ? ` · ${folderLabel({ name: status.folder })}` : ""}
    {info.incoming === "imap" && status?.folder && status.headersSynced != null && <span data-testid="mail-storage-header-progress"> · Headers: {status.headersSynced}/{status.headersTotal ?? "…"}</span>}
    <span data-testid="mail-storage-original-progress"> · Saved this scan: {status?.saved || 0}{status?.total ? `/${status.total}` : ""}</span>
    {status?.phase !== "headers" && status?.totalBytes != null && ` · Current message: ${bytes(status.bytes)} / ${bytes(status.totalBytes)} (${Math.floor(status.bytes / Math.max(1, status.totalBytes) * 100)}%)`}
  </span>;
  return <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs border-b border-[var(--taomni-divider)]">
    <button data-testid="mail-archive-open" className="taomni-btn" onClick={() => setOpen(true)}>Local archive</button>
    {progress}
    {running ? <button data-testid="mail-storage-pause" className="taomni-btn" disabled={busy || status?.phase === "pausing"} onClick={() => void action(async () => { await mailArchivePause(info.sessionId); await refresh(); })}>Pause</button>
      : <button data-testid="mail-storage-resume" className="taomni-btn" disabled={busy} onClick={() => void action(async () => { await mailArchiveStart(info, true); await refresh(); })}>{status?.phase === "failed" ? "Retry" : "Resume / scan"}</button>}
    {status?.error && <span role="alert">{status.error}</span>}
    {!open && error && <span role="alert">{error}</span>}
    {open && <MailArchiveDialog key={info.sessionId} accountId={info.sessionId} onClose={() => setOpen(false)} onChanged={refresh} />}
  </div>;
}
