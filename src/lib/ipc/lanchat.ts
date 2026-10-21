import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LanChatStatus, LanConversation, LanFileOffer, LanGroup, LanMessage, LanPeer, LanPinnedPeer, LanProfile, LanRetention, LanSecurityEvent, LanServiceState, LanSignal, LanTransferProgress } from "../../types";

/* ----------------------------- LanChat (内网通讯) ----------------------------- */

export async function lanchatStatus(): Promise<LanChatStatus> {
  return invoke<LanChatStatus>("lanchat_status");
}

export async function lanchatListPeers(): Promise<LanPeer[]> {
  return invoke<LanPeer[]>("lanchat_list_peers");
}

export async function lanchatGetProfile(): Promise<LanProfile> {
  return invoke<LanProfile>("lanchat_get_profile");
}

export async function lanchatUpdateProfile(args: {
  name: string;
  avatarBase64?: string | null;
  signature: string;
  status: string;
}): Promise<LanProfile> {
  return invoke<LanProfile>("lanchat_update_profile", { args });
}

export async function lanchatSendText(args: {
  peerId: string;
  text: string;
  mentions?: string[];
}): Promise<LanMessage> {
  return invoke<LanMessage>("lanchat_send_text", { args });
}

export async function lanchatResendMessage(msgId: string): Promise<LanMessage> {
  return invoke<LanMessage>("lanchat_resend_message", { msgId });
}

export async function lanchatListConversations(): Promise<LanConversation[]> {
  return invoke<LanConversation[]>("lanchat_list_conversations");
}

export async function lanchatListMessages(
  convId: string,
  limit?: number,
): Promise<LanMessage[]> {
  return invoke<LanMessage[]>("lanchat_list_messages", { convId, limit });
}

export async function lanchatMarkRead(convId: string): Promise<void> {
  return invoke("lanchat_mark_read", { convId });
}

export async function lanchatCreateGroup(args: {
  name: string;
  members?: string[];
}): Promise<LanGroup> {
  return invoke<LanGroup>("lanchat_create_group", { args });
}

export async function lanchatSendGroupText(args: {
  groupId: string;
  text: string;
  mentions?: string[];
}): Promise<LanMessage> {
  return invoke<LanMessage>("lanchat_send_group_text", { args });
}

export async function lanchatListGroups(): Promise<LanGroup[]> {
  return invoke<LanGroup[]>("lanchat_list_groups");
}

export async function lanchatLeaveGroup(groupId: string): Promise<void> {
  return invoke("lanchat_leave_group", { groupId });
}

export async function listenLanChatRoster(
  cb: (peers: LanPeer[]) => void,
): Promise<UnlistenFn> {
  return listen<LanPeer[]>("lanchat://roster", (e) => cb(e.payload));
}

export async function listenLanChatMessage(
  cb: (msg: LanMessage) => void,
): Promise<UnlistenFn> {
  return listen<LanMessage>("lanchat://message", (e) => cb(e.payload));
}

export async function listenLanChatConversation(
  cb: (conv: LanConversation) => void,
): Promise<UnlistenFn> {
  return listen<LanConversation>("lanchat://conversation", (e) => cb(e.payload));
}

export async function listenLanChatGroup(
  cb: (group: LanGroup) => void,
): Promise<UnlistenFn> {
  return listen<LanGroup>("lanchat://group", (e) => cb(e.payload));
}

/* ----------------------------- LanChat transfers ----------------------------- */

export async function lanchatSendFile(peerId: string, path: string): Promise<string> {
  return invoke<string>("lanchat_send_file", { peerId, path });
}

export async function lanchatSendGroupFile(groupId: string, path: string): Promise<string> {
  return invoke<string>("lanchat_send_group_file", { groupId, path });
}

export async function lanchatSendDir(peerId: string, path: string): Promise<string> {
  return invoke<string>("lanchat_send_dir", { peerId, path });
}

export async function lanchatAcceptFile(transferId: string, savePath: string): Promise<string> {
  return invoke<string>("lanchat_accept_file", { transferId, savePath });
}

export async function lanchatOpenPath(path: string): Promise<void> {
  return invoke("lanchat_open_path", { path });
}

export async function lanchatRejectFile(transferId: string): Promise<void> {
  return invoke("lanchat_reject_file", { transferId });
}

export async function lanchatTransferControl(
  transferId: string,
  action: "pause" | "resume" | "cancel",
): Promise<void> {
  return invoke("lanchat_transfer_control", { transferId, action });
}

export async function lanchatSendScreenshot(peerId: string): Promise<string> {
  return invoke<string>("lanchat_send_screenshot", { peerId });
}

export async function lanchatSendClipboardImage(peerId: string): Promise<string> {
  return invoke<string>("lanchat_send_clipboard_image", { peerId });
}

export async function lanchatSendImageBytes(peerId: string, dataB64: string): Promise<string> {
  return invoke<string>("lanchat_send_image_bytes", { peerId, data: dataB64 });
}

export async function listenLanChatTransfer(
  cb: (p: LanTransferProgress) => void,
): Promise<UnlistenFn> {
  return listen<LanTransferProgress>("lanchat://transfer", (e) => cb(e.payload));
}

export async function listenLanChatFileOffer(
  cb: (offer: LanFileOffer) => void,
): Promise<UnlistenFn> {
  return listen<LanFileOffer>("lanchat://file-offer", (e) => cb(e.payload));
}

/* ----------------------------- LanChat A/V signaling ----------------------------- */

export async function lanchatSendSignal(
  peerId: string,
  frameType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return invoke("lanchat_send_signal", { peerId, frameType, payload });
}

export async function lanchatSignalGroup(
  groupId: string,
  frameType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return invoke("lanchat_signal_group", { groupId, frameType, payload });
}

export async function listenLanChatSignal(
  cb: (s: LanSignal) => void,
): Promise<UnlistenFn> {
  return listen<LanSignal>("lanchat://signal", (e) => cb(e.payload));
}

/* ---- Native A/V media (v4, Linux / no-WebRTC stack) ---- */

/** Start a native media session for a call; returns the loopback WS port the
 *  webview connects to for decoded media. */
export async function nmediaStart(callId: string): Promise<number> {
  return invoke<number>("nmedia_start", { callId });
}

export async function nmediaStop(callId: string): Promise<void> {
  return invoke("nmedia_stop", { callId });
}

export async function nmediaWsPort(callId: string): Promise<number> {
  return invoke<number>("nmedia_ws_port", { callId });
}

export async function nmediaAddPeer(callId: string, peerId: string): Promise<void> {
  return invoke("nmedia_add_peer", { callId, peerId });
}

export async function nmediaRemovePeer(callId: string, peerId: string): Promise<void> {
  return invoke("nmedia_remove_peer", { callId, peerId });
}

export async function nmediaPeerState(
  callId: string,
  peerId: string,
  mic: boolean,
  cam: boolean,
  screen: boolean,
): Promise<void> {
  return invoke("nmedia_peer_state", { callId, peerId, mic, cam, screen });
}

export async function nmediaToggleMic(callId: string, on: boolean): Promise<void> {
  return invoke("nmedia_toggle_mic", { callId, on });
}

export async function nmediaToggleScreen(callId: string, on: boolean): Promise<void> {
  return invoke("nmedia_toggle_screen", { callId, on });
}

export async function nmediaToggleCam(callId: string, on: boolean): Promise<void> {
  return invoke("nmedia_toggle_cam", { callId, on });
}

export async function listenLanChatWb(
  cb: (s: LanSignal) => void,
): Promise<UnlistenFn> {
  return listen<LanSignal>("lanchat://wb", (e) => cb(e.payload));
}

/* ----------------------------- retention & security (phase 4) ----------------------------- */

export async function lanchatGetRetention(): Promise<LanRetention> {
  return invoke<LanRetention>("lanchat_get_retention");
}

export async function lanchatSetRetention(settings: LanRetention): Promise<void> {
  return invoke("lanchat_set_retention", { settings });
}

export async function lanchatDeleteMessage(msgId: string): Promise<void> {
  return invoke("lanchat_delete_message", { msgId });
}

export async function lanchatClearConversation(convId: string): Promise<void> {
  return invoke("lanchat_clear_conversation", { convId });
}

export async function lanchatClearAllHistory(): Promise<void> {
  return invoke("lanchat_clear_all_history");
}

export async function lanchatListPinned(): Promise<LanPinnedPeer[]> {
  return invoke<LanPinnedPeer[]>("lanchat_list_pinned");
}

export async function lanchatRetrustPeer(nodeId: string): Promise<void> {
  return invoke("lanchat_retrust_peer", { nodeId });
}

export async function listenLanChatSecurity(
  cb: (e: LanSecurityEvent) => void,
): Promise<UnlistenFn> {
  return listen<LanSecurityEvent>("lanchat://security", (e) => cb(e.payload));
}

/* ----------------------------- service enable / start-on-launch ----------------------------- */

export async function lanchatGetServiceState(): Promise<LanServiceState> {
  return invoke<LanServiceState>("lanchat_get_service_state");
}

/** Manually start the background service (one-way; runs until app exit). */
export async function lanchatStartService(): Promise<void> {
  return invoke("lanchat_start_service");
}

/** Set the "start LanChat on app launch" policy (affects next launch only). */
export async function lanchatSetStartOnLaunch(enabled: boolean): Promise<void> {
  return invoke("lanchat_set_start_on_launch", { enabled });
}

/** Service lifecycle change: fires with `{ running }` when the service starts. */
export async function listenLanChatService(
  cb: (running: boolean) => void,
): Promise<UnlistenFn> {
  return listen<{ running: boolean }>("lanchat://service", (e) =>
    cb(e.payload.running),
  );
}
