import { useEffect, useState } from "react";
import { mailListCachedFolders } from "../../lib/mail";
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
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (accountId) void mailListCachedFolders(accountId).then((list) => {
      if (active) setFolders(list.filter((f) => !f.flags.some((flag) => flag.toLowerCase() === "\\noselect")).map((f) => f.name));
    }).catch(() => { /* A new/offline account can enter exact folder names below. */ });
    return () => { active = false; };
  }, [accountId]);
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
    <p className="text-xs text-[var(--taomni-text-muted)]">Saving a new directory moves this account’s stored mail. Leave blank to use the default directory.</p>
    {pop3 ? <p>POP3 messages are stored in full on this computer.</p> : <>
      <label className="flex items-center gap-2">Save complete messages
        <select data-testid="mail-storage-mode" className="taomni-input" value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as MailStorageOptions["mode"] })}>
          <option value="all">All folders</option><option value="include">Only selected folders</option><option value="exclude">All except selected folders</option>
        </select>
      </label>
      {value.mode !== "all" && <>
        <div className="flex max-h-32 flex-wrap gap-3 overflow-auto" data-testid="mail-storage-folders">
          {Array.from(new Set([...folders, ...value.folders.filter(Boolean)])).map((folder) => <label className="flex items-center gap-1" key={folder}>
            <input type="checkbox" aria-label={folder} checked={value.folders.includes(folder)} onChange={(e) => onChange({ ...value, folders: e.target.checked ? [...value.folders, folder] : value.folders.filter((name) => name !== folder) })} />{folder}
          </label>)}
        </div>
        <label className="block">Folder names (one exact server name per line)
          <textarea data-testid="mail-storage-folder-names" aria-label="Full mail folder names" className="taomni-input w-full" rows={3} value={value.folders.join("\n")} onChange={(e) => onChange({ ...value, folders: e.target.value.split("\n") })} />
        </label>
      </>}
      <p className="text-xs text-[var(--taomni-text-muted)]">Other folders keep their headers and summaries. Complete messages include bodies, inline images and attachments. Changing the selection keeps previously saved originals.</p>
    </>}
    <p className="text-xs text-[var(--taomni-text-muted)]">Deleting mail on the server keeps its local original. Use Local archive → Clean up to physically remove it.</p>
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
