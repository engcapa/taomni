import { create } from "zustand";
import { createChatComposerActions } from "./chat/composer";
import { createChatDrawerActions } from "./chat/drawer";
import { createChatInitialState } from "./chat/initial";
import { type ChatStore } from "./chat/model";
import { createChatQueueActions } from "./chat/queueActions";
import { createChatSendingActions } from "./chat/sending";
import { createChatThreadActions } from "./chat/threads";

export const useChatStore = create<ChatStore>((set, get) => ({
  ...createChatInitialState(set, get),
  ...createChatThreadActions(set, get),
  ...createChatSendingActions(set, get),
  ...createChatQueueActions(set, get),
  ...createChatDrawerActions(set, get),
  ...createChatComposerActions(set, get),
}));

export {
  type CcToolCard,
  type CcUsage,
  type ChatComposerDraft,
  type ChatDrawerPosition,
  type ChatMessage,
  type ChatThread,
  type ChatThreadMode,
  type EnqueueResult,
  type QueuedSend,
} from "./chat/model";

export { isChatCapableTabType, normalizeChatThreadMode } from "./chat/context";

export { MAX_QUEUED_SENDS } from "./chat/queue";
