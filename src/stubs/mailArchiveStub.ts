// Renderer-only preview; disk, compression and IMAP are verified by native cases.
import type { MailTabInfo } from "../types";
import type { MailArchiveEntry, MailArchiveStatus, MailMessageBody, MailArchiveQuery, MailArchiveSelection } from "../lib/mail";
import { mailFolderSelectionMatches } from "../lib/mailFolders";
import { stubMailListFolders, stubMailCachedHeaders, type Seed } from "./mailServerStub";

type Saved = { entry: MailArchiveEntry; body: MailMessageBody };
type State = { paused: boolean; saved: Saved[]; skipped: string[]; folder?: string; headersSynced?: number; headersTotal?: number; preview?: { token: string; keys: string[] } };
const idOf = (e: Pick<MailArchiveEntry, "folder" | "uidValidity" | "uid">) => `${e.folder}/${e.uidValidity}/${e.uid}`;
export function mailArchiveStub(cmd: string, args: Record<string, unknown>, seed: Seed, read: (id: string, folder: string, uid: number) => MailMessageBody): unknown {
  const config = args.config as MailTabInfo | undefined;
  const account = (args.accountId as string | undefined) ?? config?.sessionId ?? "stub-mail";
  const key = `taomni.mail.archive.${account}`;
  const value = localStorage.getItem(key);
  const state: State = value ? JSON.parse(value) : { paused: false, saved: [], skipped: [] };
  let result: unknown;
  switch (cmd) {
    case "mail_archive_start":
      if (args.resume) state.paused = false;
      if (!state.paused && config) {
        for (const folder of stubMailListFolders(account, seed)) {
          state.folder = folder.name;
          state.headersSynced = stubMailCachedHeaders(account, seed, folder.name).length;
          state.headersTotal = folder.total ?? state.headersSynced;
          const matched = config.cache.fullMessageFolders?.some((name) => mailFolderSelectionMatches(name, folder.name)) ?? false;
          if (config.cache.fullMessageMode === "include" && !matched || config.cache.fullMessageMode === "exclude" && matched) continue;
          for (const message of stubMailCachedHeaders(account, seed, folder.name)) {
            const entry: MailArchiveEntry = { folder: folder.name, uid: message.uid, uidValidity: 1, subject: message.subject, from: [message.from?.name, message.from?.address].filter(Boolean).join(" "), to: [...message.to, ...message.cc].map((address) => [address.name, address.address].filter(Boolean).join(" ")).join(", "), dateTs: message.dateTs, hasAttachments: message.hasAttachments, rawSize: 4096, storedSize: 1024, storedAt: Math.floor(Date.now() / 1000) };
            if (!state.skipped.includes(idOf(entry)) && !state.saved.some((item) => idOf(item.entry) === idOf(entry))) state.saved.push({ entry, body: { ...read(account, folder.name, message.uid), source: "archive" } });
          }
        }
      }
      break;
    case "mail_archive_pause": state.paused = true; break;
    case "mail_archive_status": return { phase: state.paused ? "paused" : "completed", folder: state.folder, headersSynced: state.headersSynced, headersTotal: state.headersTotal, saved: state.saved.length, total: state.saved.length, bytes: 4096, totalBytes: 4096 } satisfies MailArchiveStatus;
    case "mail_archive_list": return state.saved.slice(Number(args.offset) || 0, (Number(args.offset) || 0) + 200).map((item) => item.entry);
    case "mail_archive_query": {
      const query = (args.query || {}) as MailArchiveQuery;
      const items = filterArchive(state.saved, query);
      const offset = Math.min(Number(args.offset) || 0, Math.max(0, Math.floor((items.length - 1) / 200) * 200));
      return { entries: items.slice(offset, offset + 200).map(({ entry }) => entry), offset, total: items.length, storedBytes: items.reduce((n, { entry }) => n + entry.storedSize, 0), folders: [...new Set(state.saved.map(({ entry }) => entry.folder))].sort() };
    }
    case "mail_archive_preview_cleanup": {
      const selection = args.selection as MailArchiveSelection;
      const selectedKeys = new Set((selection.keys || []).map(idOf));
      const excluded = new Set((selection.excluded || []).map(idOf));
      const items = selection.query ? filterArchive(state.saved, selection.query).filter(({ entry }) => !excluded.has(idOf(entry))) : state.saved.filter(({ entry }) => selectedKeys.has(idOf(entry)));
      const token = crypto.randomUUID();
      state.preview = { token, keys: items.map(({ entry }) => idOf(entry)) };
      const storedBytes = items.reduce((n, { entry }) => n + entry.storedSize, 0);
      result = { token, count: items.length, storedBytes, reclaimableBytes: storedBytes };
      break;
    }
    case "mail_archive_cleanup": {
      if (!state.preview || state.preview.token !== args.token) throw new Error("Cleanup preview expired. Review the selection again.");
      const keys = state.preview.keys;
      if (keys.some((key) => !state.saved.some(({ entry }) => idOf(entry) === key))) throw new Error("Preview messages changed. Review the selection again.");
      state.paused = true; state.skipped.push(...keys); state.saved = state.saved.filter(({ entry }) => !keys.includes(idOf(entry))); delete state.preview;
      result = keys.length;
      break;
    }
    case "mail_archive_read": return state.saved.find((item) => idOf(item.entry) === idOf(args.entry as MailArchiveEntry))?.body ?? null;
    case "mail_archive_remove": {
      const keys = (args.entries as MailArchiveEntry[]).map(idOf);
      state.paused = true; state.skipped.push(...keys);
      state.saved = state.saved.filter((item) => !keys.includes(idOf(item.entry)));
      result = keys.length;
      break;
    }
    case "mail_archive_export":
    case "mail_archive_attachment": break;
    default: throw new Error(`Unknown archive preview command: ${cmd}`);
  }
  localStorage.setItem(key, JSON.stringify(state));
  return result;
}

function filterArchive(saved: Saved[], q: MailArchiveQuery): Saved[] {
  const text = (q.text || "").trim().toLowerCase();
  return saved.filter(({ entry: e }) => {
    const searchable = q.field === "subject" ? e.subject : q.field === "from" ? e.from || "" : q.field === "to" ? e.to || "" : `${e.subject} ${e.from || ""} ${e.to || ""}`;
    return (!text || searchable.toLowerCase().includes(text)) && (q.folder == null || e.folder === q.folder)
      && (q.hasAttachments == null || !!e.hasAttachments === q.hasAttachments)
      && (q.dateFrom == null || e.dateTs != null && e.dateTs >= q.dateFrom) && (q.dateBefore == null || e.dateTs != null && e.dateTs < q.dateBefore)
      && (q.storedFrom == null || e.storedAt >= q.storedFrom) && (q.storedBefore == null || e.storedAt < q.storedBefore)
      && (q.minSize == null || e.rawSize >= q.minSize) && (q.maxSize == null || e.rawSize <= q.maxSize);
  }).sort(({ entry: a }, { entry: b }) => {
    const value = q.sort === "savedOldest" ? a.storedAt - b.storedAt : q.sort === "dateNewest" ? (b.dateTs || 0) - (a.dateTs || 0) : q.sort === "dateOldest" ? (a.dateTs ?? Infinity) - (b.dateTs ?? Infinity) : q.sort === "largest" ? b.rawSize - a.rawSize : q.sort === "smallest" ? a.rawSize - b.rawSize : b.storedAt - a.storedAt;
    return value || a.folder.localeCompare(b.folder) || b.uidValidity - a.uidValidity || b.uid - a.uid;
  });
}
