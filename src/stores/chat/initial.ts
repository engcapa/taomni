import type { StoreApi } from "zustand";
import { type ChatStore } from "./model";
import { initialDrawerLayoutPrefs } from "./preferences";

export function createChatInitialState(_set: StoreApi<ChatStore>["setState"], _get: StoreApi<ChatStore>["getState"]): Pick<ChatStore, "threads" | "threadsLoaded" | "activeThreadId" | "messages" | "streamingId" | "ccToolCards" | "ccUsage" | "sendingByThreadId" | "sendQueues" | "sending" | "drawerOpen" | "drawerScope" | "drawerTabId" | "tabDrawerOpenByTabId" | "activeThreadIdByTabId" | "drawerWidth" | "drawerHeight" | "drawerPosition" | "drawerPinned" | "drawerFloatingOpacity" | "ribbonOffsetRatio" | "pendingComposerText" | "composerDrafts"> {
  return {
    threads: [],
    threadsLoaded: false,
    activeThreadId: null,
    messages: {},
    streamingId: {},
    ccToolCards: {},
    ccUsage: {},
    sendingByThreadId: {},
    sendQueues: {},
    sending: false,
    drawerOpen: false,
    drawerScope: null,
    drawerTabId: null,
    tabDrawerOpenByTabId: {},
    activeThreadIdByTabId: {},
    drawerWidth: initialDrawerLayoutPrefs.width,
    drawerHeight: initialDrawerLayoutPrefs.height,
    drawerPosition: initialDrawerLayoutPrefs.position,
    drawerPinned: initialDrawerLayoutPrefs.pinned,
    drawerFloatingOpacity: initialDrawerLayoutPrefs.floatingOpacity,
    ribbonOffsetRatio: initialDrawerLayoutPrefs.ribbonOffsetRatio,
    pendingComposerText: "",
    composerDrafts: {}
  };
}
