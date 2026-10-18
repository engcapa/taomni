import { useCallback, useEffect, useRef, useState } from "react";
import type { MailTabInfo } from "../../types";
import { mailArchiveExport, mailArchiveList, mailArchivePause, mailArchiveRead, mailArchiveRemove, mailArchiveStart, mailArchiveStatus, mailArchiveAttachment, type MailArchiveEntry, type MailArchiveStatus, type MailMessageBody } from "../../lib/mail";
import { selectSaveFilePath } from "../../lib/ipc";
import { MailMessageBodyView } from "./MailMessageBodyView";
import { folderLabel } from "../../lib/mailFolders";

const activePhases = new Set(["connecting", "headers", "downloading", "verifying", "pausing", "shared"]);
const keyOf = (e: MailArchiveEntry) => `${e.folder}/${e.uidValidity}/${e.uid}`;
const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`;

export function MailArchivePanel({ info }: { info: MailTabInfo }) {
  const [status, setStatus] = useState<MailArchiveStatus | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<MailArchiveEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [entry, setEntry] = useState<MailArchiveEntry | null>(null);
  const [body, setBody] = useState<MailMessageBody | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const readVersion = useRef(0);
  const config = useRef(info);
  config.current = info;
  const identity = JSON.stringify(info);
  const refresh = useCallback(async () => setStatus(await mailArchiveStatus(info.sessionId)), [info.sessionId]);
  const load = useCallback(async (start: number) => {
    const list = await mailArchiveList(info.sessionId, start);
    setEntries(list); setOffset(start); setSelected([]); setConfirm(false);
  }, [info.sessionId]);
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
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [open]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const read = async (value: MailArchiveEntry) => {
    const version = ++readVersion.current;
    setEntry(value); setBody(null); setError("");
    try { const result = await mailArchiveRead(info.sessionId, value); if (version === readVersion.current) setBody(result); }
    catch (e) { if (version === readVersion.current) setError(String(e)); }
  };
  const close = () => { ++readVersion.current; setOpen(false); setConfirm(false); };
  const save = async (attachment?: number) => {
    if (!entry) return;
    const path = await selectSaveFilePath(attachment === undefined ? `email-${entry.uid}.eml` : body?.attachments[attachment]?.name || "attachment");
    if (!path) return;
    if (attachment === undefined) await mailArchiveExport(info.sessionId, entry, path);
    else await mailArchiveAttachment(info.sessionId, entry, attachment, path);
    setNotice(`Saved ${path}`);
  };
  const running = activePhases.has(status?.phase || "");
  const progress = <span data-testid="mail-storage-progress" role="status">
    Full mail: {status?.phase === "shared" ? "syncing in another instance" : status?.phase || "connecting"}{status?.folder ? ` · ${folderLabel({ name: status.folder })}` : ""}
    {info.incoming === "imap" && status?.folder && status.headersSynced != null && <span data-testid="mail-storage-header-progress"> · Headers: {status.headersSynced}/{status.headersTotal ?? "…"}</span>}
    <span data-testid="mail-storage-original-progress"> · Saved this scan: {status?.saved || 0}{status?.total ? `/${status.total}` : ""}</span>
    {status?.phase !== "headers" && status?.totalBytes != null && ` · Current message: ${bytes(status.bytes)} / ${bytes(status.totalBytes)} (${Math.floor(status.bytes / Math.max(1, status.totalBytes) * 100)}%)`}
  </span>;
  return <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs border-b border-[var(--taomni-divider)]">
    <button data-testid="mail-archive-open" className="taomni-btn" onClick={() => void action(async () => { await load(0); setOpen(true); })}>Local archive</button>
    {progress}
    {running ? <button data-testid="mail-storage-pause" className="taomni-btn" disabled={busy || status?.phase === "pausing"} onClick={() => void action(async () => { await mailArchivePause(info.sessionId); await refresh(); })}>Pause</button>
      : <button data-testid="mail-storage-resume" className="taomni-btn" disabled={busy} onClick={() => void action(async () => { await mailArchiveStart(info, true); await refresh(); })}>{status?.phase === "failed" ? "Retry" : "Resume / scan"}</button>}
    {status?.error && <span role="alert">{status.error}</span>}
    {!open && error && <span role="alert">{error}</span>}
    <dialog ref={dialog} data-testid="mail-archive-dialog" className="w-[min(1100px,90vw)] max-h-[85vh] rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[var(--taomni-text)] p-4 backdrop:bg-black/40" onCancel={close} onClose={close} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2"><h2 className="flex-1 font-semibold">Local archive</h2><button className="taomni-btn" data-testid="mail-archive-close" onClick={close}>Close</button></div>
      <p className="my-2">Originals remain available after server deletion. Cleaning up removes the selected local originals and pauses full storage. These messages will not be downloaded automatically again.</p>
      <div className="flex flex-wrap gap-2 my-2">
        <button className="taomni-btn" data-testid="mail-archive-refresh" disabled={busy} onClick={() => void action(() => load(offset))}>Refresh</button>
        <button className="taomni-btn" data-testid="mail-archive-cleanup" disabled={busy || !selected.length} onClick={() => setConfirm(true)}>Clean up ({selected.length})</button>
        <button className="taomni-btn" data-testid="mail-archive-prev" disabled={busy || offset === 0} onClick={() => void action(() => load(Math.max(0, offset - 200)))}>Previous</button>
        <button className="taomni-btn" data-testid="mail-archive-next" disabled={busy || entries.length < 200} onClick={() => void action(() => load(offset + 200))}>Next</button>
      </div>
      {confirm && <div role="alert" className="p-2 border border-[var(--taomni-divider)]" data-testid="mail-archive-confirm">
        Physically remove {selected.length} local originals? Other copies sharing the same content and server messages are kept.
        <button className="taomni-btn ml-2" data-testid="mail-archive-confirm-remove" disabled={busy} onClick={() => void action(async () => {
          await mailArchiveRemove(info.sessionId, entries.filter((value) => selected.includes(keyOf(value))));
          ++readVersion.current; setBody(null); setEntry(null); await load(offset); await refresh(); setNotice("Local originals removed");
        })}>Remove local originals</button>
        <button className="taomni-btn ml-2" data-testid="mail-archive-confirm-cancel" onClick={() => setConfirm(false)}>Cancel</button>
      </div>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status" data-testid="mail-archive-notice">{notice}</p>}
      <div className="grid grid-cols-2 gap-3 min-h-48">
        <div className="max-h-[52vh] overflow-auto" data-testid="mail-archive-entries">
          {!entries.length && <p>No complete messages stored yet.</p>}
          {entries.map((value) => <div key={keyOf(value)} data-testid="mail-archive-row" className="flex items-center gap-2 border-b border-[var(--taomni-divider)] py-2">
            <input type="checkbox" aria-label={`Select ${value.subject}`} checked={selected.includes(keyOf(value))} onChange={(e) => { setConfirm(false); setSelected((old) => e.target.checked ? [...old, keyOf(value)] : old.filter((key) => key !== keyOf(value))); }} />
            <button className="min-w-0 text-left flex-1" data-testid="mail-archive-read" onClick={() => void read(value)}><span className="block truncate">{value.subject || "(no subject)"}</span><span className="text-[var(--taomni-text-muted)]">{value.folder} · {bytes(value.storedSize)} / {bytes(value.rawSize)}</span></button>
          </div>)}
        </div>
        <div className="min-w-0 max-h-[52vh] overflow-auto" data-testid="mail-archive-preview">
          {entry && <><h3>{entry.subject}</h3><button className="taomni-btn my-2" data-testid="mail-archive-export" disabled={busy} onClick={() => void action(() => save())}>Save original EML</button></>}
          {body && <><div className="flex flex-wrap gap-2">{body.attachments.map((attachment, index) => <button key={index} className="taomni-btn" data-testid="mail-archive-attachment" disabled={busy} onClick={() => void action(() => save(index))}>{attachment.name || `Attachment ${index + 1}`}</button>)}</div><MailMessageBodyView html={body.html} text={body.text} title={body.subject} allowRemoteImages={false} /></>}
        </div>
      </div>
    </dialog>
  </div>;
}
