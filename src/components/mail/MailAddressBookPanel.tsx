import { useCallback, useEffect, useMemo, useState } from "react";
import { CloudOff, Download, Loader2, Mail as MailIcon, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import type { MailTabInfo } from "../../types";
import {
  addressBookMatches,
  emptyAddressBookEntry,
  mailCardDavSync,
  mailDeleteAddressBookEntry,
  mailExportVcards,
  mailImportVcards,
  mailListAddressBook,
  mailSaveAddressBookEntry,
  syncSummary,
  type MailAddressBookEntry,
} from "../../lib/mailContacts";

export interface MailAddressBookPanelProps {
  info: MailTabInfo;
  /** Opens the editor on a new entry (e.g. "Add sender to address book"). */
  initialDraft?: MailAddressBookEntry | null;
  /** Start a message to the entry's first address. */
  onCompose?: (entry: MailAddressBookEntry) => void;
  onStatus?: (message: string) => void;
}

const inputClass = "h-7 px-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[12px] min-w-0";

function ListEditor({
  label,
  values,
  placeholder,
  testId,
  onChange,
}: {
  label: string;
  values: string[];
  placeholder: string;
  testId: string;
  onChange: (values: string[]) => void;
}) {
  const rows = values.length ? values : [""];
  return (
    <div className="flex items-start gap-2">
      <span className="w-20 shrink-0 pt-1.5 text-[var(--taomni-text-muted)]">{label}</span>
      <div className="flex-1 min-w-0 space-y-1">
        {rows.map((value, index) => (
          <div key={index} className="flex items-center gap-1">
            <input
              className={`${inputClass} flex-1`}
              value={value}
              placeholder={placeholder}
              aria-label={`${label} ${index + 1}`}
              data-testid={testId}
              onChange={(event) => onChange(rows.map((item, i) => (i === index ? event.target.value : item)))}
            />
            <button
              type="button"
              className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              disabled={rows.length === 1}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        <button type="button" className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]" onClick={() => onChange([...rows, ""])}>
          <Plus className="w-3 h-3" /> {label}
        </button>
      </div>
    </div>
  );
}

export function MailAddressBookPanel({ info, initialDraft, onCompose, onStatus }: MailAddressBookPanelProps) {
  const [entries, setEntries] = useState<MailAddressBookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<MailAddressBookEntry | null>(initialDraft ?? null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const carddav = !!info.carddav?.url?.trim();

  const reload = useCallback(async () => {
    try {
      setEntries(await mailListAddressBook(info.sessionId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [info.sessionId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  useEffect(() => {
    if (initialDraft) setDraft(initialDraft);
  }, [initialDraft]);

  const visible = useMemo(() => entries.filter((entry) => addressBookMatches(entry, query)), [entries, query]);
  const pending = entries.filter((entry) => entry.pendingSync).length;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await mailSaveAddressBookEntry(info, {
        ...draft,
        emails: draft.emails.map((email) => email.trim()).filter(Boolean),
        phones: draft.phones.map((phone) => phone.trim()).filter(Boolean),
      });
      onStatus?.(`Saved ${saved.displayName}${saved.pendingSync ? " (sync to upload)" : ""}`);
      setDraft(null);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: MailAddressBookEntry) => {
    setError(null);
    try {
      await mailDeleteAddressBookEntry(info.sessionId, entry.uid);
      onStatus?.(`Deleted ${entry.displayName}`);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await mailCardDavSync(info);
      setSyncErrors(result.errors);
      onStatus?.(syncSummary(result));
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const importFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ title: "Import contacts", multiple: false, filters: [{ name: "vCard", extensions: ["vcf", "vcard"] }] });
      if (typeof path !== "string" || !path.trim()) return;
      const count = await mailImportVcards(info, path);
      onStatus?.(`Imported ${count} contact${count === 1 ? "" : "s"}${carddav ? "; sync to upload them" : ""}`);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const exportFile = async () => {
    try {
      const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
      const path = await saveDialog({ title: "Export contacts", defaultPath: "contacts.vcf" });
      if (typeof path !== "string" || !path.trim()) return;
      const count = await mailExportVcards(info.sessionId, path);
      onStatus?.(`Exported ${count} contact${count === 1 ? "" : "s"} to ${path}`);
    } catch (e) {
      setError(String(e));
    }
  };

  if (draft) {
    const canSave = !!(draft.displayName.trim() || draft.emails.some((email) => email.trim()));
    return (
      <div className="flex-1 min-h-0 flex flex-col text-[12px]" data-testid="mail-contact-editor">
        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-2">
          <label className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-[var(--taomni-text-muted)]">Name</span>
            <input
              className={`${inputClass} flex-1`}
              value={draft.displayName}
              aria-label="Contact name"
              data-testid="mail-contact-name"
              onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
            />
          </label>
          <ListEditor label="Email" values={draft.emails} placeholder="name@example.com" testId="mail-contact-email" onChange={(emails) => setDraft({ ...draft, emails })} />
          <ListEditor label="Phone" values={draft.phones} placeholder="+1 555 0100" testId="mail-contact-phone" onChange={(phones) => setDraft({ ...draft, phones })} />
          <label className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-[var(--taomni-text-muted)]">Organization</span>
            <input className={`${inputClass} flex-1`} value={draft.org ?? ""} aria-label="Organization" data-testid="mail-contact-org" onChange={(event) => setDraft({ ...draft, org: event.target.value })} />
          </label>
          <label className="flex items-start gap-2">
            <span className="w-20 shrink-0 pt-1 text-[var(--taomni-text-muted)]">Note</span>
            <textarea className="flex-1 min-h-[60px] p-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[12px]" value={draft.note ?? ""} aria-label="Note" onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
          </label>
          {error && <div className="text-red-500" data-testid="mail-contact-error">{error}</div>}
        </div>
        <div className="h-11 shrink-0 px-3 flex items-center gap-2 border-t border-[var(--taomni-divider)]">
          <span className="text-[var(--taomni-text-muted)]">
            {draft.book === "carddav" || (!draft.uid && carddav) ? "CardDAV address book" : "Local address book"}
          </span>
          <span className="flex-1" />
          <button type="button" className="taomni-btn h-7 px-3" onClick={() => setDraft(null)}>Cancel</button>
          <button
            type="button"
            className="taomni-btn h-7 px-3 inline-flex items-center gap-1 text-[var(--taomni-accent)]"
            data-testid="mail-contact-save"
            disabled={!canSave || saving}
            onClick={() => void save()}
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save contact
          </button>
        </div>
      </div>
    );
  }

  const iconButton = "taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center";
  return (
    <div className="flex-1 min-h-0 flex flex-col text-[12px]" data-testid="mail-address-book">
      <div className="h-9 shrink-0 px-3 flex items-center gap-1.5 border-b border-[var(--taomni-divider)]">
        <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1" data-testid="mail-contact-new" onClick={() => setDraft(emptyAddressBookEntry())}>
          <Plus className="w-3.5 h-3.5" /> New contact
        </button>
        <input
          className={`${inputClass} flex-1`}
          value={query}
          placeholder="Search contacts"
          aria-label="Search contacts"
          data-testid="mail-contact-search"
          onChange={(event) => setQuery(event.target.value)}
        />
        {carddav && (
          <button
            type="button"
            className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
            data-testid="mail-carddav-sync"
            title={info.carddav?.url}
            disabled={syncing}
            onClick={() => void sync()}
          >
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Sync{pending ? ` (${pending})` : ""}
          </button>
        )}
        <button type="button" className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center" title="Import vCard" aria-label="Import vCard" onClick={() => void importFile()}>
          <Upload className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center" title="Export vCard" aria-label="Export vCard" disabled={entries.length === 0} onClick={() => void exportFile()}>
          <Download className="w-3.5 h-3.5" />
        </button>
      </div>
      {error && <div className="px-3 py-1.5 text-red-500 border-b border-[var(--taomni-divider)]" data-testid="mail-address-book-error">{error}</div>}
      {syncErrors.length > 0 && (
        <div className="px-3 py-1.5 border-b border-[var(--taomni-divider)] text-red-500" data-testid="mail-carddav-errors">
          {syncErrors.map((message) => <div key={message}>{message}</div>)}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {loading ? (
          <div className="p-3 flex items-center gap-2 text-[var(--taomni-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading contacts…</div>
        ) : visible.length === 0 ? (
          <div className="p-3 text-[var(--taomni-text-muted)]" data-testid="mail-address-book-empty">
            {entries.length === 0
              ? `No contacts yet.${carddav ? " Use Sync to download the CardDAV address book." : " Add one or import a vCard file."}`
              : "No contact matches the search."}
          </div>
        ) : visible.map((entry) => (
          <div key={entry.uid} className="px-2 py-1.5 flex items-center gap-2 rounded hover:bg-[var(--taomni-hover)]" data-testid="mail-contact-row" data-contact-name={entry.displayName}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">
                {entry.displayName}
                {entry.org ? <span className="ml-1 font-normal text-[var(--taomni-text-muted)]">· {entry.org}</span> : null}
              </div>
              <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">{[...entry.emails, ...entry.phones].join(", ")}</div>
            </div>
            {entry.pendingSync && <span title="Not yet on the CardDAV server"><CloudOff className="w-3 h-3 text-amber-500" /></span>}
            {onCompose && entry.emails.length > 0 && (
              <button type="button" className={iconButton} title={`Write to ${entry.emails[0]}`} aria-label={`Write to ${entry.displayName}`} data-testid="mail-contact-compose" onClick={() => onCompose(entry)}>
                <MailIcon className="w-3 h-3" />
              </button>
            )}
            <button type="button" className={iconButton} title="Edit" aria-label={`Edit ${entry.displayName}`} data-testid="mail-contact-edit" onClick={() => setDraft({ ...entry, emails: entry.emails.length ? entry.emails : [""] })}>
              <Pencil className="w-3 h-3" />
            </button>
            <button type="button" className={iconButton} title="Delete" aria-label={`Delete ${entry.displayName}`} data-testid="mail-contact-delete" onClick={() => void remove(entry)}>
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
