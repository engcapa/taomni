import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../../types";
import { withVaultLockedNotice } from "../ipc";
import { type MailInvite, type MailInviteReply, type MailInviteResponse } from "./types";

export function mailGetInvite(
  config: MailTabInfo,
  folder: string,
  uid: number,
): Promise<MailInvite | null> {
  return withVaultLockedNotice(() =>
    invoke<MailInvite | null>("mail_get_invite", { config, folder, uid }),
  );
}

export function mailRespondInvite(
  config: MailTabInfo,
  folder: string,
  uid: number,
  response: MailInviteReply,
): Promise<MailInviteResponse> {
  return withVaultLockedNotice(() =>
    invoke<MailInviteResponse>("mail_respond_invite", { config, folder, uid, response }),
  );
}

/** RFC 3503 keyword: the read receipt request was answered or declined. */
export const MAIL_MDN_SENT = "$MDNSent";

export function mailSendReceipt(
  config: MailTabInfo,
  folder: string,
  uid: number,
  automatic = false,
): Promise<{ sentTo: string; }> {
  return withVaultLockedNotice(() =>
    invoke<{ sentTo: string; }>("mail_send_receipt", { config, folder, uid, automatic }),
  );
}
