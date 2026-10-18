// Renderer-only preview; disk, compression and IMAP are verified by native cases.
import type { MailTabInfo } from "../types";
import type { MailArchiveEntry, MailArchiveStatus, MailMessageBody } from "../lib/mail";
import { mailFolderSelectionMatches } from "../lib/mailFolders";
import { stubMailListFolders, stubMailCachedHeaders, type Seed } from "./mailServerStub";

type Saved = { entry: MailArchiveEntry; body: MailMessageBody };
type State = { paused: boolean; saved: Saved[]; skipped: string[]; folder?: string; headersSynced?: number; headersTotal?: number };
const idOf = (e: MailArchiveEntry) => `${e.folder}/${e.uidValidity}/${e.uid}`;
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
            const entry: MailArchiveEntry = { folder: folder.name, uid: message.uid, uidValidity: 1, subject: message.subject, rawSize: 4096, storedSize: 1024, storedAt: Math.floor(Date.now() / 1000) };
            if (!state.skipped.includes(idOf(entry)) && !state.saved.some((item) => idOf(item.entry) === idOf(entry))) state.saved.push({ entry, body: { ...read(account, folder.name, message.uid), source: "archive" } });
          }
        }
      }
      break;
    case "mail_archive_pause": state.paused = true; break;
    case "mail_archive_status": return { phase: state.paused ? "paused" : "completed", folder: state.folder, headersSynced: state.headersSynced, headersTotal: state.headersTotal, saved: state.saved.length, total: state.saved.length, bytes: 4096, totalBytes: 4096 } satisfies MailArchiveStatus;
    case "mail_archive_list": return state.saved.slice(Number(args.offset) || 0, (Number(args.offset) || 0) + 200).map((item) => item.entry);
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
