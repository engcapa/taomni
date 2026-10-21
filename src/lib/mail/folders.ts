import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../../types";
import { withVaultLockedNotice } from "../ipc";
import { type MailFolder, type MailSyncOptions, type MailSyncAllResult, type MailSyncFolderOptions, type MailFolderSyncResult } from "./types";

/** LIST the remote folder tree (no message sync); resolves to cached folders. */
export function mailListFolders(config: MailTabInfo): Promise<MailFolder[]> {
  return withVaultLockedNotice(() => invoke<MailFolder[]>("mail_list_folders", { config }));
}

/** SUBSCRIBE/UNSUBSCRIBE a folder; resolves to the refreshed folder list. */
export function mailSetFolderSubscription(
  config: MailTabInfo,
  folder: string,
  subscribed: boolean,
): Promise<MailFolder[]> {
  return withVaultLockedNotice(() =>
    invoke<MailFolder[]>("mail_set_folder_subscription", { config, folder, subscribed }),
  );
}

/** Tauri event emitted by an open tab's IMAP IDLE watcher (TASK-12). */
export const MAIL_IDLE_EVENT = "mail://idle";

/** Start the account's IDLE watcher while its mail tab is open. */
export function mailIdleStart(config: MailTabInfo, folder = "INBOX"): Promise<boolean> {
  return withVaultLockedNotice(() => invoke<boolean>("mail_idle_start", { config, folder }));
}

/** Stop the account's IDLE watcher (tab closed; DEC-01). */
export function mailIdleStop(accountId: string): Promise<boolean> {
  return invoke<boolean>("mail_idle_stop", { accountId });
}

export function mailListCachedFolders(accountId: string): Promise<MailFolder[]> {
  return invoke<MailFolder[]>("mail_list_cached_folders", { accountId });
}

export function mailSyncAllFolders(
  config: MailTabInfo,
  options: Pick<MailSyncOptions, "limit" | "includeBodies"> & { fullReconcile?: boolean; } = {},
): Promise<MailSyncAllResult> {
  return withVaultLockedNotice(() =>
    invoke<MailSyncAllResult>("mail_sync_all_folders", {
      config,
      limit: options.limit ?? null,
      includeBodies: options.includeBodies ?? null,
      fullReconcile: options.fullReconcile ?? null,
    }),
  );
}

/** One gap-free sync step for a folder; repeat while `result.more`. */
export function mailSyncFolder(
  config: MailTabInfo,
  folder: string,
  options: MailSyncFolderOptions = {},
): Promise<MailFolderSyncResult> {
  return withVaultLockedNotice(() =>
    invoke<MailFolderSyncResult>("mail_sync_folder", {
      config,
      folder,
      mode: options.mode ?? null,
      limit: options.limit ?? null,
      includeBodies: options.includeBodies ?? null,
    }),
  );
}

export function mailCreateFolder(config: MailTabInfo, name: string): Promise<MailFolder[]> {
  return withVaultLockedNotice(() =>
    invoke<MailFolder[]>("mail_create_folder", { config, name }),
  );
}

export function mailRenameFolder(
  config: MailTabInfo,
  from: string,
  to: string,
): Promise<MailFolder[]> {
  return withVaultLockedNotice(() =>
    invoke<MailFolder[]>("mail_rename_folder", { config, from, to }),
  );
}

export function mailDeleteFolder(config: MailTabInfo, name: string): Promise<MailFolder[]> {
  return withVaultLockedNotice(() =>
    invoke<MailFolder[]>("mail_delete_folder", { config, name }),
  );
}
