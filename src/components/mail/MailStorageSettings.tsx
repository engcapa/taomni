import { useEffect, useState } from "react";
import { mailListCachedFolders, type MailFolder } from "../../lib/mail";
import { folderLabel, isSelectable, mailFolderSelectionMatches } from "../../lib/mailFolders";
import { selectFolderPath } from "../../lib/ipc";

export interface MailStorageOptions {
  directory: string;
  mode: "all" | "include" | "exclude";
  folders: string[];
}

export function mailStorageOptions(options: Record<string, unknown>): MailStorageOptions {
  return {
    directory: typeof options.mailStorageDirectory === "string" ? options.mailStorageDirectory : "",
    mode: options.mailFullMessageMode === "include" || options.mailFullMessageMode === "exclude" ? options.mailFullMessageMode : "all",
    folders: Array.isArray(options.mailFullMessageFolders) ? options.mailFullMessageFolders.filter((v): v is string => typeof v === "string") : [],
  };
}

export function MailStorageSettings({ accountId, value, onChange, pop3 }: {
  accountId?: string;
  value: MailStorageOptions;
  onChange: (value: MailStorageOptions) => void;
  pop3: boolean;
}) {
  const [folders, setFolders] = useState<{ accountId: string; folders: MailFolder[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setFolders(null);
    if (accountId && !pop3) void mailListCachedFolders(accountId).then((list) => {
      if (active) setFolders({ accountId, folders: list.filter(isSelectable) });
    }).catch(() => { /* A new/offline account can enter exact folder names below. */ });
    return () => { active = false; };
  }, [accountId, pop3]);
  const cachedFolders = folders?.accountId === accountId ? folders?.folders ?? [] : [];
  const folderChoices = new Map(cachedFolders.map((folder) => [folder.name, folderLabel(folder)]));
  const selectedFolders = new Set<string>();
  for (const name of value.folders.map((name) => name.trim()).filter(Boolean)) {
    const key = folderChoices.has(name) ? name
      : Array.from(folderChoices.keys()).find((folder) => mailFolderSelectionMatches(name, folder)) ?? name;
    selectedFolders.add(key);
    if (!folderChoices.has(key)) folderChoices.set(key, folderLabel({ name: key }));
  }
  const browse = async () => {
    try {
      setError("");
      const path = await selectFolderPath(value.directory || undefined);
      if (path) onChange({ ...value, directory: path });
    } catch (e) { setError(String(e)); }
  };
  return <fieldset className="col-span-12 my-3 space-y-2 rounded border border-[var(--taomni-divider)] p-3" data-testid="mail-storage-settings">
    <legend className="px-1">Complete mail storage</legend>
    <label className="flex flex-wrap items-center gap-2">Storage directory
      <input data-testid="mail-storage-directory" aria-label="Mail storage directory" className="taomni-input flex-1 min-w-40" value={value.directory} placeholder="Default application mail directory" onChange={(e) => onChange({ ...value, directory: e.target.value })} />
      <button type="button" className="taomni-btn" data-testid="mail-storage-browse" onClick={() => void browse()}>Browse</button>
    </label>
    <p className="text-xs text-[var(--taomni-text-muted)]">Stores this account’s mail database and complete message originals for offline use. Saving a new directory moves the stored mail. Leave blank to use the default directory.</p>
    {pop3 ? <p>POP3 messages are stored in full on this computer.</p> : <>
      <label className="flex items-center gap-2">Save complete messages
        <select data-testid="mail-storage-mode" className="taomni-input" value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as MailStorageOptions["mode"] })}>
          <option value="all">All folders</option><option value="include">Only selected folders</option><option value="exclude">All except selected folders</option>
        </select>
      </label>
      {value.mode !== "all" && <>
        <div className="flex max-h-32 flex-wrap gap-3 overflow-auto" data-testid="mail-storage-folders">
          {Array.from(folderChoices, ([folder, label]) => <label className="flex items-center gap-1" key={folder}>
            <input type="checkbox" aria-label={label} value={folder} checked={selectedFolders.has(folder)} onChange={(e) => onChange({ ...value, folders: e.target.checked ? [...value.folders.filter((name) => name.trim()), folder] : value.folders.filter((name) => name.trim() && !mailFolderSelectionMatches(name, folder)) })} />{label}
          </label>)}
        </div>
        <p className="text-xs text-[var(--taomni-text-muted)]">{cachedFolders.length > 0
          ? "Folders from the last sync; available offline. This page does not connect to the server."
          : "No cached folders. Connect and sync this account first, or enter readable folder names below."}</p>
        <div>
          <p>{value.mode === "exclude" ? "Excluded folders" : "Selected folders"}</p>
          <ul data-testid="mail-storage-selected-folders" aria-label="Selected mail folders" className="max-h-32 overflow-auto">
            {Array.from(selectedFolders).map((name) =>
              <li key={name}>{folderChoices.get(name) ?? folderLabel({ name })}</li>)}
          </ul>
          {!value.folders.some((name) => name.trim()) && <p className="text-xs text-[var(--taomni-text-muted)]">No folders selected.</p>}
        </div>
        <details>
          <summary data-testid="mail-storage-edit-folders" className="cursor-pointer">Advanced: edit folder names</summary>
          <p className="text-xs text-[var(--taomni-text-muted)]">Enter readable names (including Chinese) or original IMAP names, one full folder path per line. Both work for inclusion and exclusion, even before the first sync. Names are case-sensitive except INBOX.</p>
          <label className="block">Folder names (one full path per line)
            <textarea data-testid="mail-storage-folder-names" aria-label="Full mail folder names" className="taomni-input w-full" rows={3} value={value.folders.join("\n")} onChange={(e) => onChange({ ...value, folders: e.target.value.split("\n") })} />
          </label>
        </details>
      </>}
      <p className="text-xs text-[var(--taomni-text-muted)]">Other folders keep their headers and summaries. Complete messages include bodies, inline images and attachments. Changing the selection keeps previously saved originals.</p>
    </>}
    <p className="text-xs text-[var(--taomni-text-muted)]">Deleting mail on the server keeps its local original. Use Local archive → Clean up to physically remove it.</p>
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
