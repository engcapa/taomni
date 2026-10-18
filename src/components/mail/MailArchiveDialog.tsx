import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mailArchiveAttachment, mailArchiveCleanup, mailArchiveExport, mailArchivePreviewCleanup, mailArchiveQuery, mailArchiveRead, type MailArchiveEntry, type MailArchiveKey, type MailArchivePage, type MailArchiveQuery, type MailCleanupPreview, type MailMessageBody } from "../../lib/mail";
import { selectSaveFilePath } from "../../lib/ipc";
import { folderLabel } from "../../lib/mailFolders";
import { MailMessageBodyView } from "./MailMessageBodyView";

const keyOf = (e: MailArchiveKey) => JSON.stringify([e.folder, e.uidValidity, e.uid]);
const keyOnly = ({ folder, uid, uidValidity }: MailArchiveKey): MailArchiveKey => ({ folder, uid, uidValidity });
export const archiveBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(2)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`;
const dateLabel = (n?: number | null) => n == null ? "Unknown date" : new Date(n * 1000).toLocaleDateString();
const emptyPage: MailArchivePage = { entries: [], total: 0, storedBytes: 0, folders: [], offset: 0 };
const initialFilters = { text: "", field: "all", folder: "", attachments: "any", dateFrom: "", dateTo: "", storedFrom: "", storedTo: "", minSize: "", maxSize: "" };
type Filters = typeof initialFilters;
function day(value: string, next = false) {
  if (!value) return null;
  const result = new Date(`${value}T00:00:00`);
  if (next) result.setDate(result.getDate() + 1);
  return Math.floor(result.getTime() / 1000);
}
function buildQuery(f: Filters, sort: MailArchiveQuery["sort"]): MailArchiveQuery {
  const min = f.minSize ? Number(f.minSize) * 1024 ** 2 : null;
  const max = f.maxSize ? Number(f.maxSize) * 1024 ** 2 : null;
  if ([min, max].some((n) => n !== null && (!Number.isFinite(n) || n < 0)) || (min !== null && max !== null && min > max)) throw new Error("Enter a valid size range (minimum must not exceed maximum).");
  if ((f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) || (f.storedFrom && f.storedTo && f.storedFrom > f.storedTo)) throw new Error("The end date must not precede the start date.");
  return { text: f.text, field: f.field as MailArchiveQuery["field"], folder: f.folder || null, hasAttachments: f.attachments === "any" ? null : f.attachments === "yes", dateFrom: day(f.dateFrom), dateBefore: day(f.dateTo, true), storedFrom: day(f.storedFrom), storedBefore: day(f.storedTo, true), minSize: min === null ? null : Math.round(min), maxSize: max === null ? null : Math.round(max), sort };
}

export function MailArchiveDialog({ accountId, onClose, onChanged }: { accountId: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [filters, setFilters] = useState(initialFilters);
  const [sort, setSort] = useState<MailArchiveQuery["sort"]>("savedNewest");
  const [page, setPage] = useState(emptyPage);
  const [selected, setSelected] = useState<Record<string, MailArchiveKey>>({});
  const [all, setAll] = useState(false);
  const [excluded, setExcluded] = useState<Record<string, MailArchiveKey>>({});
  const [preview, setPreview] = useState<MailCleanupPreview | null>(null);
  const [entry, setEntry] = useState<MailArchiveEntry | null>(null);
  const [body, setBody] = useState<MailMessageBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const readVersion = useRef(0);
  const rangeAnchor = useRef<number | null>(null);
  const applied = useRef<MailArchiveQuery>({});
  const count = all ? Math.max(0, page.total - Object.keys(excluded).length) : Object.keys(selected).length;
  const isSelected = (value: MailArchiveKey) => all ? !excluded[keyOf(value)] : !!selected[keyOf(value)];
  const pageSelected = page.entries.filter(isSelected).length;
  const pageCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (pageCheckbox.current) pageCheckbox.current.indeterminate = pageSelected > 0 && pageSelected < page.entries.length; }, [pageSelected, page.entries.length]);
  const input = useMemo(() => {
    try { return { query: buildQuery(filters, sort), error: "" }; }
    catch (e) { return { query: null, error: (e as Error).message }; }
  }, [filters, sort]);
  const clearSelection = () => { setSelected({}); setExcluded({}); setAll(false); setPreview(null); rangeAnchor.current = null; };
  const change = (key: keyof Filters, value: string) => {
    ++request.current; setLoading(true); setFilters((old) => ({ ...old, [key]: value })); clearSelection(); setNotice("");
  };
  const load = useCallback(async (query: MailArchiveQuery, offset: number) => {
    const version = ++request.current;
    setLoading(true); setError(""); setPreview(null);
    try {
      const result = await mailArchiveQuery(accountId, query, offset);
      if (version !== request.current) return;
      applied.current = query; setPage(result); rangeAnchor.current = null;
    } catch (e) { if (version === request.current) setError(String(e)); }
    finally { if (version === request.current) setLoading(false); }
  }, [accountId]);
  useEffect(() => {
    dialog.current?.showModal(); search.current?.focus();
    return () => { ++request.current; ++readVersion.current; };
  }, []);
  useEffect(() => {
    if (!input.query) { ++request.current; setLoading(false); return; }
    const timer = window.setTimeout(() => void load(input.query!, 0), 250);
    return () => { window.clearTimeout(timer); ++request.current; };
  }, [input, load]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const read = async (value: MailArchiveEntry) => {
    const version = ++readVersion.current; setEntry(value); setBody(null); setError("");
    try { const result = await mailArchiveRead(accountId, value); if (version === readVersion.current) setBody(result); }
    catch (e) { if (version === readVersion.current) setError(String(e)); }
  };
  const save = async (attachment?: number) => {
    if (!entry) return;
    const path = await selectSaveFilePath(attachment === undefined ? `email-${entry.uid}.eml` : body?.attachments[attachment]?.name || "attachment");
    if (!path) return;
    if (attachment === undefined) await mailArchiveExport(accountId, entry, path);
    else await mailArchiveAttachment(accountId, entry, attachment, path);
    setNotice(`Saved ${path}`);
  };
  const select = (values: MailArchiveEntry[], checked: boolean) => {
    setPreview(null);
    if (all) setExcluded((old) => { const next = { ...old }; for (const value of values) { if (checked) delete next[keyOf(value)]; else next[keyOf(value)] = keyOnly(value); } return next; });
    else setSelected((old) => { const next = { ...old }; for (const value of values) { if (checked) next[keyOf(value)] = keyOnly(value); else delete next[keyOf(value)]; } return next; });
  };
  const review = () => void action(async () => {
    const value = await mailArchivePreviewCleanup(accountId, all ? { query: applied.current, excluded: Object.values(excluded) } : { keys: Object.values(selected) });
    if (!value.count) { clearSelection(); await load(applied.current, page.offset); setNotice("Selected originals are no longer available."); return; }
    setPreview(value);
  });
  const disabled = busy || loading || !!input.error;
  const advancedCount = [filters.dateFrom, filters.dateTo, filters.storedFrom, filters.storedTo, filters.minSize, filters.maxSize].filter(Boolean).length;
  return <dialog ref={dialog} aria-labelledby="mail-archive-title" data-testid="mail-archive-dialog"
    className="m-auto w-[min(1440px,96vw)] h-[min(850px,92vh)] max-w-none max-h-none rounded-xl border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[var(--taomni-text)] p-0 shadow-2xl backdrop:bg-black/40"
    onCancel={(e) => { if (busy) e.preventDefault(); else if (preview) { e.preventDefault(); setPreview(null); } }} onClose={onClose}
    onKeyDown={(e) => {
      e.stopPropagation();
      const editing = (e.target as HTMLElement).matches("input,textarea,select,[contenteditable=true]");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); search.current?.focus(); search.current?.select(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !editing && !disabled && !preview) { e.preventDefault(); select(page.entries, true); }
      if (e.key === "Delete" && !editing && count && !disabled && !preview) { e.preventDefault(); review(); }
    }}>
    <div className="flex h-full min-h-0 flex-col text-sm">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--taomni-divider)] px-5 py-4">
        <div><h2 id="mail-archive-title" className="text-lg font-semibold">Local archive</h2><p className="mt-1 text-xs text-[var(--taomni-text-muted)]">Find and manage saved originals. Server messages are kept.</p></div>
        <button className="taomni-btn" data-testid="mail-archive-close" disabled={busy} onClick={onClose}>Close</button>
      </header>
      <fieldset disabled={busy || !!preview} className="min-w-0 border-b border-[var(--taomni-divider)] px-5 py-3 space-y-3">
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (input.query) void load(input.query, 0); }}>
          <input ref={search} data-testid="mail-archive-search" aria-label="Search local archive" placeholder="Search saved mail… (Ctrl+F)" className="taomni-input min-w-48 flex-1" value={filters.text} onChange={(e) => change("text", e.target.value)} />
          <select data-testid="mail-archive-search-field" aria-label="Search in" className="taomni-input" value={filters.field} onChange={(e) => change("field", e.target.value)}><option value="all">All addresses & subject</option><option value="subject">Subject</option><option value="from">Sender</option><option value="to">Recipients</option></select>
          <select data-testid="mail-archive-folder" aria-label="Archive folder" className="taomni-input max-w-64" value={filters.folder} onChange={(e) => change("folder", e.target.value)}><option value="">All folders</option>{page.folders.map((folder) => <option key={folder} value={folder}>{folderLabel({ name: folder })}</option>)}</select>
          <select data-testid="mail-archive-attachments" aria-label="Attachments" className="taomni-input" value={filters.attachments} onChange={(e) => change("attachments", e.target.value)}><option value="any">Any attachments</option><option value="yes">With attachments</option><option value="no">Without attachments</option></select>
          <button type="button" data-testid="mail-archive-reset" className="taomni-btn" onClick={() => { ++request.current; setLoading(true); setFilters({ ...initialFilters }); clearSelection(); setNotice(""); }}>Reset filters</button>
        </form>
        <details data-testid="mail-archive-advanced"><summary className="cursor-pointer text-xs text-[var(--taomni-text-muted)]">Dates & size{advancedCount ? ` · ${advancedCount} active` : ""}</summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div><span className="block mb-1 text-xs">Mail date</span><div className="flex items-center gap-1"><input type="date" data-testid="mail-archive-date-from" aria-label="Mail date from" className="taomni-input min-w-0 w-full" value={filters.dateFrom} onChange={(e) => change("dateFrom", e.target.value)} /><span>–</span><input type="date" data-testid="mail-archive-date-to" aria-label="Mail date through" className="taomni-input min-w-0 w-full" value={filters.dateTo} onChange={(e) => change("dateTo", e.target.value)} /></div></div>
            <div><span className="block mb-1 text-xs">Saved locally</span><div className="flex items-center gap-1"><input type="date" data-testid="mail-archive-stored-from" aria-label="Saved from" className="taomni-input min-w-0 w-full" value={filters.storedFrom} onChange={(e) => change("storedFrom", e.target.value)} /><span>–</span><input type="date" data-testid="mail-archive-stored-to" aria-label="Saved through" className="taomni-input min-w-0 w-full" value={filters.storedTo} onChange={(e) => change("storedTo", e.target.value)} /></div></div>
            <div><span className="block mb-1 text-xs">Original size (MiB)</span><div className="flex items-center gap-1"><input type="number" min="0" step="any" data-testid="mail-archive-min-size" aria-label="Minimum size in MiB" placeholder="Min" className="taomni-input min-w-0 w-full" value={filters.minSize} onChange={(e) => change("minSize", e.target.value)} /><span>–</span><input type="number" min="0" step="any" data-testid="mail-archive-max-size" aria-label="Maximum size in MiB" placeholder="Max" className="taomni-input min-w-0 w-full" value={filters.maxSize} onChange={(e) => change("maxSize", e.target.value)} /></div></div>
          </div>
        </details>
      </fieldset>
      {(error || input.error) && <p role="alert" className="px-5 py-2 text-red-500">{input.error || error}</p>}
      {notice && <p role="status" data-testid="mail-archive-notice" className="px-5 py-2">{notice}</p>}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--taomni-divider)] px-5 py-2">
        <label className="flex items-center gap-2"><input ref={pageCheckbox} type="checkbox" data-testid="mail-archive-select-page" checked={!!page.entries.length && pageSelected === page.entries.length} disabled={disabled || !!preview || !page.entries.length} onChange={(e) => select(page.entries, e.target.checked)} />Select page</label>
        <button data-testid="mail-archive-select-all" className="taomni-btn" disabled={disabled || !!preview || !page.total || all} onClick={() => { setAll(true); setExcluded({}); setSelected({}); }}>Select all {page.total} matching</button>
        <button data-testid="mail-archive-clear-selection" className="taomni-btn" disabled={busy || !!preview || !count} onClick={clearSelection}>Clear selection</button>
        <span data-testid="mail-archive-selection-count" className="text-xs">{count} selected{all ? " across all pages" : ""}</span>
        <button data-testid="mail-archive-cleanup" className="taomni-btn" disabled={disabled || !!preview || !count} onClick={review}>Clean up ({count})</button>
        <div className="flex-1" />
        <select data-testid="mail-archive-sort" aria-label="Sort archive" className="taomni-input text-xs" disabled={busy || !!preview} value={sort} onChange={(e) => { ++request.current; setLoading(true); setSort(e.target.value as MailArchiveQuery["sort"]); }}><option value="savedNewest">Saved: newest first</option><option value="savedOldest">Saved: oldest first</option><option value="dateNewest">Mail date: newest first</option><option value="dateOldest">Mail date: oldest first</option><option value="largest">Size: largest first</option><option value="smallest">Size: smallest first</option></select>
        <button className="taomni-btn" data-testid="mail-archive-refresh" disabled={disabled || !!preview} onClick={() => void load(applied.current, page.offset)}>Refresh</button>
      </div>
      {preview && <section role="alertdialog" aria-label="Confirm local cleanup" data-testid="mail-archive-confirm" className="mx-5 my-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
        <h3 className="font-semibold">Remove {preview.count} local originals?</h3>
        <p data-testid="mail-archive-cleanup-estimate" className="my-2">Selected stored size: {archiveBytes(preview.storedBytes)} · Up to {archiveBytes(preview.reclaimableBytes)} reclaimable</p>
        <p className="text-xs text-[var(--taomni-text-muted)]">Shared originals are kept until their last copy is removed. Backups may retain disk space. This cannot be undone. Server messages are kept; full storage pauses and these originals will not download automatically again.</p>
        <div className="mt-3 flex gap-2"><button className="taomni-btn" data-testid="mail-archive-confirm-cancel" disabled={busy} onClick={() => setPreview(null)}>Cancel</button><button className="taomni-btn text-red-600" data-testid="mail-archive-confirm-remove" disabled={busy} onClick={() => void action(async () => {
          const removed = await mailArchiveCleanup(accountId, preview.token); clearSelection(); ++readVersion.current; setBody(null); setEntry(null); await load(applied.current, page.offset); await onChanged(); setNotice(`Removed ${removed} local originals. Server messages kept.`);
        })}>{busy ? "Cleaning up…" : "Remove local originals"}</button></div>
      </section>}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div data-testid="mail-archive-entries" aria-busy={loading} className="min-h-0 overflow-auto border-r border-[var(--taomni-divider)]" tabIndex={0}>
          {loading && <p role="status" className="p-5">Searching local archive…</p>}
          {!loading && !page.entries.length && <p className="p-5 text-[var(--taomni-text-muted)]">{Object.entries(filters).some(([k, v]) => v !== initialFilters[k as keyof Filters]) ? "No saved mail matches these filters. Try resetting them." : "No complete messages stored yet."}</p>}
          {!loading && page.entries.map((value, index) => <div key={keyOf(value)} data-testid="mail-archive-row" className={`flex items-start gap-3 border-b border-[var(--taomni-divider)] px-4 py-3 ${entry && keyOf(entry) === keyOf(value) ? "bg-blue-500/10" : "hover:bg-black/5 dark:hover:bg-white/5"}`}>
            <input type="checkbox" className="mt-1" aria-label={`Select ${value.subject}`} checked={isSelected(value)} disabled={busy || !!preview || !!input.error} onChange={(e) => {
              const shift = (e.nativeEvent as MouseEvent).shiftKey;
              select(shift && rangeAnchor.current !== null ? page.entries.slice(Math.min(index, rangeAnchor.current), Math.max(index, rangeAnchor.current) + 1) : [value], e.target.checked); rangeAnchor.current = index;
            }} />
            <button className="min-w-0 flex-1 text-left" data-testid="mail-archive-read" onClick={() => void read(value)}>
              <span className="flex items-start justify-between gap-2"><span className="truncate font-medium">{value.subject || "(no subject)"}</span><span className="shrink-0 text-xs text-[var(--taomni-text-muted)]">{archiveBytes(value.rawSize)}</span></span>
              <span className="mt-1 block truncate text-xs">{value.from || "Unknown sender"}</span>
              <span className="mt-1 block truncate text-xs text-[var(--taomni-text-muted)]">{folderLabel({ name: value.folder })} · {dateLabel(value.dateTs)}{value.hasAttachments ? " · Attachment" : ""}</span>
              <span className="block text-xs text-[var(--taomni-text-muted)]">Saved {dateLabel(value.storedAt)} · {archiveBytes(value.storedSize)} stored</span>
            </button>
          </div>)}
        </div>
        <div data-testid="mail-archive-preview" className="min-h-0 min-w-0 overflow-auto p-5">
          {!entry && <div className="flex h-full min-h-32 items-center justify-center text-[var(--taomni-text-muted)]">Select a message to preview its saved original.</div>}
          {entry && <><h3 className="break-words font-semibold">{entry.subject}</h3><p className="mt-2 break-words text-xs">From: {entry.from || "Unknown sender"}<br />To: {entry.to || "Unknown recipients"}</p><button className="taomni-btn my-3" data-testid="mail-archive-export" disabled={busy} onClick={() => void action(() => save())}>Save original EML</button></>}
          {body && <><div className="mb-3 flex flex-wrap gap-2">{body.attachments.map((attachment, index) => <button key={index} className="taomni-btn" data-testid="mail-archive-attachment" disabled={busy} onClick={() => void action(() => save(index))}>{attachment.name || `Attachment ${index + 1}`}</button>)}</div><MailMessageBodyView html={body.html} text={body.text} title={body.subject} allowRemoteImages={false} /></>}
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-3 border-t border-[var(--taomni-divider)] px-5 py-3 text-xs">
        <span data-testid="mail-archive-results" role="status">{loading ? "Searching…" : `${page.total ? page.offset + 1 : 0}–${page.offset + page.entries.length} of ${page.total} messages · ${archiveBytes(page.storedBytes)} stored`}</span>
        <span className="hidden flex-1 text-[var(--taomni-text-muted)] lg:block">Ctrl+F search · Ctrl+A select page · Delete review cleanup</span>
        <button className="taomni-btn" data-testid="mail-archive-prev" disabled={disabled || !!preview || page.offset === 0} onClick={() => void load(applied.current, Math.max(0, page.offset - 200))}>Previous</button>
        <button className="taomni-btn" data-testid="mail-archive-next" disabled={disabled || !!preview || page.offset + page.entries.length >= page.total} onClick={() => void load(applied.current, page.offset + 200)}>Next</button>
      </footer>
    </div>
  </dialog>;
}
