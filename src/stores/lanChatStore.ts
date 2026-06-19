import { create } from "zustand";

import {
  lanchatAcceptFile,
  lanchatClearAllHistory,
  lanchatClearConversation,
  lanchatCreateGroup,
  lanchatDeleteMessage,
  lanchatGetProfile,
  lanchatGetRetention,
  lanchatGetServiceState,
  lanchatListConversations,
  lanchatListGroups,
  lanchatListMessages,
  lanchatListPeers,
  lanchatMarkRead,
  lanchatOpenPath,
  lanchatRejectFile,
  lanchatResendMessage,
  lanchatRetrustPeer,
  lanchatSendClipboardImage,
  lanchatSendFile,
  lanchatSendGroupText,
  lanchatSendImageBytes,
  lanchatSendScreenshot,
  lanchatSendText,
  lanchatSetRetention,
  lanchatSetStartOnLaunch,
  lanchatStartService,
  lanchatTransferControl,
  lanchatUpdateProfile,
  listenLanChatConversation,
  listenLanChatFileOffer,
  listenLanChatGroup,
  listenLanChatMessage,
  listenLanChatRoster,
  listenLanChatSecurity,
  listenLanChatService,
  listenLanChatTransfer,
} from "../lib/ipc";
import { isTauriRuntime } from "../lib/runtime";
import { notifyLanMessage } from "../lib/lanNotify";
import type {
  LanConversation,
  LanFileOffer,
  LanGroup,
  LanMessage,
  LanPeer,
  LanProfile,
  LanRetention,
  LanSecurityEvent,
  LanTransferProgress,
} from "../types";

/** Which left-panel segment is shown. */
export type LanSegment = "members" | "groups";

/** Screen edge the in-app drawer docks to. */
export type LanEdgeSide = "top" | "bottom" | "left" | "right";

interface LanChatStore {
  /** True only in the desktop (Tauri) runtime; browser preview is read-only. */
  isDesktop: boolean;
  initialized: boolean;
  /** When true, this window does not raise desktop notifications (detached). */
  suppressNotifications: boolean;
  profile: LanProfile | null;
  roster: LanPeer[];
  conversations: LanConversation[];
  groups: LanGroup[];
  /** Messages keyed by conversation id (oldest-first). */
  messagesByConv: Record<string, LanMessage[]>;
  segment: LanSegment;
  activeConvId: string | null;
  /** Edge the active conversation is docked to as an in-app drawer (null = not docked). */
  edgeDock: LanEdgeSide | null;
  /** Whether the docked drawer is expanded (false = collapsed to the peek tab). */
  edgeOpen: boolean;
  /** Active/recent transfers keyed by transfer id. */
  transfers: Record<string, LanTransferProgress>;
  /** Pending inbound file offers awaiting accept/reject. */
  offers: LanFileOffer[];
  /** Local file path for each transfer (source for send, save for recv). */
  transferPaths: Record<string, string>;
  /** Message-retention policy (loaded on init; null until then). */
  retention: LanRetention | null;
  /** Recent unacknowledged security alerts (rejected peer identities). */
  securityAlerts: LanSecurityEvent[];
  /** Whether the background service (discovery/transport/beacon) is running. */
  serviceRunning: boolean;
  /** Whether the service is configured to start on app launch. */
  startOnLaunch: boolean;

  /** Load profile + roster + conversations + groups and subscribe to events. */
  init: () => Promise<void>;
  setSegment: (seg: LanSegment) => void;
  /** Dock the active conversation to a window edge as an in-app drawer. */
  openEdgeDock: (side: LanEdgeSide) => void;
  /** Expand / collapse (to the peek tab) the docked drawer. */
  setEdgeOpen: (open: boolean) => void;
  /** Undock the drawer entirely. */
  closeEdgeDock: () => void;
  openConversation: (convId: string) => Promise<void>;
  /** Open (or create) a direct conversation with a peer and select it. */
  openDirect: (peerId: string) => Promise<void>;
  sendCurrent: (text: string, mentions?: string[]) => Promise<void>;
  resend: (msgId: string) => Promise<void>;
  /** Peer id of the active conversation if it is a direct chat, else null. */
  activePeerId: () => string | null;
  sendScreenshot: () => Promise<void>;
  sendClipboardImage: () => Promise<void>;
  /** Send a local file (by absolute path) to the active conversation's peer. */
  sendFilePath: (path: string) => Promise<void>;
  acceptOffer: (transferId: string) => Promise<void>;
  rejectOffer: (transferId: string) => Promise<void>;
  transferControl: (transferId: string, action: "pause" | "resume" | "cancel") => Promise<void>;
  openTransfer: (transferId: string) => Promise<void>;
  saveProfile: (args: {
    name: string;
    avatarBase64?: string | null;
    signature: string;
    status: string;
  }) => Promise<void>;
  createGroup: (name: string, members: string[]) => Promise<LanGroup | null>;

  // retention & history management
  loadRetention: () => Promise<void>;
  saveRetention: (settings: LanRetention) => Promise<void>;
  deleteMessage: (convId: string, msgId: string) => Promise<void>;
  clearConversation: (convId: string) => Promise<void>;
  clearAllHistory: () => Promise<void>;
  // security
  retrustPeer: (nodeId: string) => Promise<void>;
  dismissSecurityAlert: (peerId: string) => void;
  applySecurityEvent: (e: LanSecurityEvent) => void;

  // service enablement
  /** Refresh `serviceRunning` + `startOnLaunch` from the backend. */
  loadServiceState: () => Promise<void>;
  /** Manually start the service (one-way; runs until app exit). */
  enableService: () => Promise<void>;
  /** Persist the start-on-launch policy (affects next launch only). */
  setStartOnLaunch: (enabled: boolean) => Promise<void>;

  // event-driven mutators
  applyRoster: (peers: LanPeer[]) => void;
  applyMessage: (msg: LanMessage) => void;
  applyConversation: (conv: LanConversation) => void;
  applyGroup: (group: LanGroup) => void;
  applyTransfer: (p: LanTransferProgress) => void;
  applyOffer: (offer: LanFileOffer) => void;
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

/** Conversation id for a direct chat with `peerId` (matches the backend). */
export function directConvId(peerId: string): string {
  return `direct:${peerId}`;
}

/** Members shown in the roster column: mDNS-discovered peers plus any peer we
 *  have a direct conversation with but never resolved over mDNS (cross-segment
 *  / multicast-pruned Wi-Fi). Without this, an inbound chat from an
 *  undiscovered peer is stored but has no row to open or reply from. */
export function mergedMemberPeers(
  roster: LanPeer[],
  conversations: LanConversation[],
): LanPeer[] {
  const byId = new Map<string, LanPeer>();
  for (const p of roster) byId.set(p.id, p);
  for (const c of conversations) {
    if (c.kind !== "direct" || byId.has(c.peerOrGroupId)) continue;
    byId.set(c.peerOrGroupId, {
      id: c.peerOrGroupId,
      name: c.peerOrGroupId.slice(0, 8),
      signature: "",
      status: "offline",
      lastSeen: c.lastMsgAt,
      addr: null,
      port: null,
    });
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

/** Total unread across all conversations (for the global badge). */
export function totalUnread(convs: LanConversation[]): number {
  return convs.reduce((sum, c) => sum + (c.unread > 0 ? c.unread : 0), 0);
}

let unsubscribers: Array<() => void> = [];

export const useLanChatStore = create<LanChatStore>((set, get) => ({
  isDesktop: isTauriRuntime(),
  initialized: false,
  suppressNotifications: false,
  profile: null,
  roster: [],
  conversations: [],
  groups: [],
  messagesByConv: {},
  segment: "members",
  activeConvId: null,
  edgeDock: null,
  edgeOpen: true,
  transfers: {},
  offers: [],
  transferPaths: {},
  retention: null,
  securityAlerts: [],
  serviceRunning: false,
  startOnLaunch: false,

  init: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    try {
      const [profile, conversations, groups, peers] = await Promise.all([
        lanchatGetProfile(),
        lanchatListConversations(),
        lanchatListGroups(),
        lanchatListPeers(),
      ]);
      set({ profile, conversations, groups, roster: peers });
      // Retention policy is best-effort; ignore if unavailable.
      try {
        set({ retention: await lanchatGetRetention() });
      } catch (e) {
        console.debug("lanchat retention:", e);
      }
      // Service enablement state (running + start-on-launch). Best-effort.
      try {
        const svc = await lanchatGetServiceState();
        set({ serviceRunning: svc.running, startOnLaunch: svc.startOnLaunch });
      } catch (e) {
        console.debug("lanchat service state:", e);
      }
    } catch (e) {
      // Browser preview / backend not ready: leave defaults, stub fills mocks.
      console.debug("lanchat init:", e);
    }
    // Subscribe to backend events (each window has its own store + listeners).
    try {
      unsubscribers.push(await listenLanChatRoster((peers) => get().applyRoster(peers)));
      unsubscribers.push(await listenLanChatMessage((msg) => get().applyMessage(msg)));
      unsubscribers.push(
        await listenLanChatConversation((conv) => get().applyConversation(conv)),
      );
      unsubscribers.push(await listenLanChatGroup((group) => get().applyGroup(group)));
      unsubscribers.push(await listenLanChatTransfer((p) => get().applyTransfer(p)));
      unsubscribers.push(await listenLanChatFileOffer((o) => get().applyOffer(o)));
      unsubscribers.push(await listenLanChatSecurity((e) => get().applySecurityEvent(e)));
      unsubscribers.push(
        await listenLanChatService((running) => set({ serviceRunning: running })),
      );
    } catch (e) {
      console.debug("lanchat listen:", e);
    }
  },

  setSegment: (segment) => set({ segment }),

  openEdgeDock: (side) => set({ edgeDock: side, edgeOpen: true }),
  setEdgeOpen: (open) => set({ edgeOpen: open }),
  closeEdgeDock: () => set({ edgeDock: null, edgeOpen: true }),

  openConversation: async (convId) => {
    set({ activeConvId: convId });
    try {
      const msgs = await lanchatListMessages(convId);
      set((s) => ({ messagesByConv: { ...s.messagesByConv, [convId]: msgs } }));
      await lanchatMarkRead(convId);
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === convId ? { ...c, unread: 0 } : c,
        ),
      }));
    } catch (e) {
      console.debug("lanchat openConversation:", e);
    }
  },

  openDirect: async (peerId) => {
    await get().openConversation(directConvId(peerId));
  },

  sendCurrent: async (text, mentions = []) => {
    const convId = get().activeConvId;
    if (!convId) return;
    try {
      if (convId.startsWith("group:")) {
        await lanchatSendGroupText({ groupId: convId.slice("group:".length), text, mentions });
      } else if (convId.startsWith("direct:")) {
        await lanchatSendText({ peerId: convId.slice("direct:".length), text, mentions });
      }
    } catch (e) {
      console.debug("lanchat send:", e);
      throw e;
    }
  },

  resend: async (msgId) => {
    try {
      await lanchatResendMessage(msgId);
    } catch (e) {
      console.debug("lanchat resend:", e);
    }
  },

  activePeerId: () => {
    const conv = get().activeConvId;
    return conv && conv.startsWith("direct:") ? conv.slice("direct:".length) : null;
  },

  sendScreenshot: async () => {
    const peerId = get().activePeerId();
    if (!peerId) throw new Error("截图仅支持发送给单个成员");
    try {
      await lanchatSendScreenshot(peerId);
    } catch {
      // Native capture unavailable (screen-capture feature off, macOS, or an
      // xcap runtime error) — fall back to a webview getDisplayMedia frame.
      const { captureScreenPng } = await import("../lib/lanScreenCapture");
      const b64 = await captureScreenPng();
      await lanchatSendImageBytes(peerId, b64);
    }
  },

  sendClipboardImage: async () => {
    const peerId = get().activePeerId();
    if (!peerId) throw new Error("发送剪贴板图片仅支持单个成员");
    await lanchatSendClipboardImage(peerId);
  },

  sendFilePath: async (path) => {
    const peerId = get().activePeerId();
    if (!peerId) throw new Error("发送文件仅支持单个成员");
    const transferId = await lanchatSendFile(peerId, path);
    set((s) => ({ transferPaths: { ...s.transferPaths, [transferId]: path } }));
  },

  acceptOffer: async (transferId) => {
    try {
      const savedPath = await lanchatAcceptFile(transferId, "");
      set((s) => ({
        offers: s.offers.filter((o) => o.transferId !== transferId),
        transferPaths: { ...s.transferPaths, [transferId]: savedPath },
      }));
    } catch (e) {
      console.debug("lanchat acceptOffer:", e);
    }
  },

  rejectOffer: async (transferId) => {
    try {
      await lanchatRejectFile(transferId);
    } catch {
      /* ignore */
    }
    set((s) => ({ offers: s.offers.filter((o) => o.transferId !== transferId) }));
  },

  transferControl: async (transferId, action) => {
    try {
      await lanchatTransferControl(transferId, action);
    } catch (e) {
      console.debug("lanchat transferControl:", e);
    }
  },

  openTransfer: async (transferId) => {
    const path = get().transferPaths[transferId];
    if (path) {
      try {
        await lanchatOpenPath(path);
      } catch (e) {
        console.debug("lanchat openTransfer:", e);
      }
    }
  },

  saveProfile: async (args) => {
    const profile = await lanchatUpdateProfile(args);
    set({ profile });
  },

  createGroup: async (name, members) => {
    try {
      const group = await lanchatCreateGroup({ name, members });
      set((s) => ({ groups: upsertById(s.groups, group) }));
      return group;
    } catch (e) {
      console.debug("lanchat createGroup:", e);
      return null;
    }
  },

  loadRetention: async () => {
    try {
      set({ retention: await lanchatGetRetention() });
    } catch (e) {
      console.debug("lanchat loadRetention:", e);
    }
  },

  saveRetention: async (settings) => {
    await lanchatSetRetention(settings);
    set({ retention: settings });
  },

  deleteMessage: async (convId, msgId) => {
    try {
      await lanchatDeleteMessage(msgId);
      set((s) => ({
        messagesByConv: {
          ...s.messagesByConv,
          [convId]: (s.messagesByConv[convId] ?? []).filter((m) => m.id !== msgId),
        },
      }));
    } catch (e) {
      console.debug("lanchat deleteMessage:", e);
    }
  },

  clearConversation: async (convId) => {
    try {
      await lanchatClearConversation(convId);
      set((s) => ({ messagesByConv: { ...s.messagesByConv, [convId]: [] } }));
    } catch (e) {
      console.debug("lanchat clearConversation:", e);
    }
  },

  clearAllHistory: async () => {
    try {
      await lanchatClearAllHistory();
      set({ messagesByConv: {} });
    } catch (e) {
      console.debug("lanchat clearAllHistory:", e);
    }
  },

  retrustPeer: async (nodeId) => {
    try {
      await lanchatRetrustPeer(nodeId);
    } catch (e) {
      console.debug("lanchat retrustPeer:", e);
    }
    get().dismissSecurityAlert(nodeId);
  },

  dismissSecurityAlert: (peerId) =>
    set((s) => ({ securityAlerts: s.securityAlerts.filter((a) => a.peerId !== peerId) })),

  applySecurityEvent: (e) =>
    set((s) => ({
      securityAlerts: [...s.securityAlerts.filter((a) => a.peerId !== e.peerId), e],
    })),

  loadServiceState: async () => {
    try {
      const svc = await lanchatGetServiceState();
      set({ serviceRunning: svc.running, startOnLaunch: svc.startOnLaunch });
    } catch (e) {
      console.debug("lanchat loadServiceState:", e);
    }
  },

  enableService: async () => {
    try {
      await lanchatStartService();
      // Optimistic; the lanchat://service event confirms when actually live.
      set({ serviceRunning: true });
    } catch (e) {
      console.debug("lanchat enableService:", e);
    }
  },

  setStartOnLaunch: async (enabled) => {
    try {
      await lanchatSetStartOnLaunch(enabled);
      set({ startOnLaunch: enabled });
    } catch (e) {
      console.debug("lanchat setStartOnLaunch:", e);
    }
  },

  applyRoster: (peers) => set({ roster: peers }),

  applyMessage: (msg) =>
    set((s) => {
      const existing = s.messagesByConv[msg.convId] ?? [];
      const next = upsertById(existing, msg).sort((a, b) => a.createdAt - b.createdAt);
      const isNew = !existing.some((m) => m.id === msg.id);
      const myId = s.profile?.id ?? "";
      const fromMe = msg.senderId === myId;
      const mentioned = msg.mentions.includes(myId);
      // Notify on a genuinely new inbound message that is either a mention or
      // belongs to a conversation that isn't currently open.
      if (isNew && !fromMe && (mentioned || msg.convId !== s.activeConvId)) {
        if (!s.suppressNotifications) {
          const senderName =
            s.roster.find((p) => p.id === msg.senderId)?.name ?? msg.senderId.slice(0, 6);
          const title = mentioned ? `${senderName} 提到了你` : senderName;
          void notifyLanMessage(title, msg.body.slice(0, 120));
        }
      }
      return { messagesByConv: { ...s.messagesByConv, [msg.convId]: next } };
    }),

  applyConversation: (conv) =>
    set((s) => {
      // If this conversation is open, treat it as read.
      const merged = s.activeConvId === conv.id ? { ...conv, unread: 0 } : conv;
      const conversations = upsertById(s.conversations, merged).sort(
        (a, b) => b.lastMsgAt - a.lastMsgAt,
      );
      return { conversations };
    }),

  applyGroup: (group) => set((s) => ({ groups: upsertById(s.groups, group) })),

  applyTransfer: (p) =>
    set((s) => ({ transfers: { ...s.transfers, [p.transferId]: p } })),

  applyOffer: (offer) =>
    set((s) => ({
      offers: [...s.offers.filter((o) => o.transferId !== offer.transferId), offer],
    })),
}));

/** Tear down event listeners (used when a window unmounts the module). */
export function disposeLanChat(): void {
  unsubscribers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
  unsubscribers = [];
}
