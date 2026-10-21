import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../../types";
import { withVaultLockedNotice } from "../ipc";
import { type MailDraft, type MailDraftSaveRequest } from "./types";

export function mailListDrafts(accountId: string): Promise<MailDraft[]> {
  return invoke<MailDraft[]>("mail_list_drafts", { accountId });
}

export function mailSaveDraft(
  accountId: string,
  draft: MailDraftSaveRequest,
): Promise<MailDraft> {
  return invoke<MailDraft>("mail_save_draft", { accountId, draft });
}

export function mailDeleteDraft(accountId: string, draftId: string): Promise<void> {
  return invoke("mail_delete_draft", { accountId, draftId });
}

/** Store (or replace) the draft's copy in the server Drafts folder. */
export function mailStoreRemoteDraft(config: MailTabInfo, draftId: string): Promise<MailDraft> {
  return withVaultLockedNotice(() =>
    invoke<MailDraft>("mail_store_remote_draft", { config, draftId }),
  );
}

/** Remove the draft's server copy; resolves false when it had none. */
export function mailDiscardRemoteDraft(config: MailTabInfo, draftId: string): Promise<boolean> {
  return withVaultLockedNotice(() =>
    invoke<boolean>("mail_discard_remote_draft", { config, draftId }),
  );
}
