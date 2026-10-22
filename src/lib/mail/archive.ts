import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../../types";
import {
  type MailArchiveQuery,
  type MailArchivePage,
  type MailArchiveSelection,
  type MailCleanupPreview,
  type MailArchiveStatus,
  type MailArchiveEntry,
  type MailMessageBody,
} from "./types";

export const mailArchiveQuery = (accountId: string, query: MailArchiveQuery, offset = 0) => invoke<MailArchivePage>("mail_archive_query", { accountId, query, offset });

export const mailArchivePreviewCleanup = (accountId: string, selection: MailArchiveSelection) => invoke<MailCleanupPreview>("mail_archive_preview_cleanup", { accountId, selection });

export const mailArchiveCleanup = (accountId: string, token: string) => invoke<number>("mail_archive_cleanup", { accountId, token });

export const mailArchiveStart = (config: MailTabInfo, resume = false) => invoke<void>("mail_archive_start", { config, resume });

export const mailArchivePause = (accountId: string) => invoke<void>("mail_archive_pause", { accountId });

export const mailArchiveStatus = (accountId: string) => invoke<MailArchiveStatus>("mail_archive_status", { accountId });

export const mailArchiveList = (accountId: string, offset = 0) => invoke<MailArchiveEntry[]>("mail_archive_list", { accountId, offset });

export const mailArchiveRead = (accountId: string, entry: MailArchiveEntry) => invoke<MailMessageBody>("mail_archive_read", { accountId, entry });

export const mailArchiveExport = (accountId: string, entry: MailArchiveEntry, targetPath: string) => invoke<void>("mail_archive_export", { accountId, entry, targetPath });

export const mailArchiveRemove = (accountId: string, entries: MailArchiveEntry[]) => invoke<number>("mail_archive_remove", { accountId, entries });

export const mailArchiveAttachment = (accountId: string, entry: MailArchiveEntry, attachmentIndex: number, targetPath: string) => invoke<void>("mail_archive_attachment", { accountId, entry, attachmentIndex, targetPath });
