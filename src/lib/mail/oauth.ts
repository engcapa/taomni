import { invoke } from "@tauri-apps/api/core";
import { withVaultLockedNotice } from "../ipc";
import {
  type MailOAuthAuthorizeRequest,
  type MailOAuthAuthorizeResult,
  type MailOAuthDeviceStartRequest,
  type MailOAuthDeviceStartResult,
  type MailOAuthDeviceCompleteRequest,
} from "./types";

export function mailOAuthAuthorize(
  request: MailOAuthAuthorizeRequest,
): Promise<MailOAuthAuthorizeResult> {
  return withVaultLockedNotice(() =>
    invoke<MailOAuthAuthorizeResult>("mail_oauth_authorize", { request }),
  );
}

export function mailOAuthDeviceStart(
  request: MailOAuthDeviceStartRequest,
): Promise<MailOAuthDeviceStartResult> {
  return withVaultLockedNotice(() =>
    invoke<MailOAuthDeviceStartResult>("mail_oauth_device_start", { request }),
  );
}

export function mailOAuthDeviceComplete(
  request: MailOAuthDeviceCompleteRequest,
): Promise<MailOAuthAuthorizeResult> {
  return withVaultLockedNotice(() =>
    invoke<MailOAuthAuthorizeResult>("mail_oauth_device_complete", { request }),
  );
}
