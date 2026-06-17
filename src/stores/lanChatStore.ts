import { create } from "zustand";

import {
  lanchatCreateGroup,
  lanchatGetProfile,
  lanchatListConversations,
  lanchatListGroups,
  lanchatListMessages,
  lanchatListPeers,
  lanchatMarkRead,
  lanchatResendMessage,
  lanchatSendGroupText,
  lanchatSendText,
  lanchatUpdateProfile,
  listenLanChatConversation,
  listenLanChatGroup,
  listenLanChatMessage,
  listenLanChatRoster,
} from "../lib/ipc";
import { isTauriRuntime } from "../lib/runtime";
import { notifyLanMessage } from "../lib/lanNotify";
import type {
  LanConversation,
  LanGroup,
  LanMessage,
  LanPeer,
  LanProfile,
} from "../types";

/** Which left-panel segment is shown. */
export type LanSegment = "members" | "groups";

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

  /** Load profile + roster + conversations + groups and subscribe to events. */
  init: () => Promise<void>;
  setSegment: (seg: LanSegment) => void;
  openConversation: (convId: string) => Promise<void>;
  /** Open (or create) a direct conversation with a peer and select it. */
  openDirect: (peerId: string) => Promise<void>;
  sendCurrent: (text: string, mentions?: string[]) => Promise<void>;
  resend: (msgId: string) => Promise<void>;
  saveProfile: (args: {
    name: string;
    avatarBase64?: string | null;
    signature: string;
    status: string;
  }) => Promise<void>;
  createGroup: (name: string, members: string[]) => Promise<LanGroup | null>;

  // event-driven mutators
  applyRoster: (peers: LanPeer[]) => void;
  applyMessage: (msg: LanMessage) => void;
  applyConversation: (conv: LanConversation) => void;
  applyGroup: (group: LanGroup) => void;
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
    } catch (e) {
      console.debug("lanchat listen:", e);
    }
  },

  setSegment: (segment) => set({ segment }),

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
