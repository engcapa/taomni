import { Image as ImageIcon, MessageSquare, PanelBottomOpen, PanelLeftOpen, PanelRightOpen, PanelTopOpen, Video } from "lucide-react";
import { type ChatDrawerPosition, type ChatThreadMode, type QueuedSend } from "../../../stores/chatStore";
import { acpProfileIdFromProvider, providerGroupIdFromRoute, type AiConfig, type LlmProviderCapability } from "../../../stores/aiStore";
import { type TranslateFn } from "../../../lib/i18n";

/** Stable empty array so a thread with no queue does not churn renders. */
export const EMPTY_QUEUE: QueuedSend[] = [];

export const DRAWER_POSITIONS: ChatDrawerPosition[] = ["left", "right", "top", "bottom"];

export const CHAT_THREAD_MODES: ChatThreadMode[] = ["chat", "image", "video"];

export function capabilityForMode(mode: ChatThreadMode): LlmProviderCapability {
  if (mode === "image") return "image_generation";
  if (mode === "video") return "video_generation";
  return "chat";
}

export function modeIcon(mode: ChatThreadMode) {
  if (mode === "image") return ImageIcon;
  if (mode === "video") return Video;
  return MessageSquare;
}

export function providerLabel(id: string, t: TranslateFn, config?: AiConfig | null): string {
  if (id === "claude-code") return t("chat.claudeCodeLocal");
  if (id === "codex") return "Codex local";
  if (id === "opencode-go") return "OpenCode Go";
  const acpProfileId = acpProfileIdFromProvider(id);
  if (acpProfileId) {
    const profile = config?.acp_bridge.profiles.find((candidate) => candidate.id === acpProfileId);
    return `${profile?.name || acpProfileId} (ACP)`;
  }
  const groupId = providerGroupIdFromRoute(id);
  if (groupId) {
    const label = config?.llm.provider_groups?.[groupId]?.label || groupId;
    return `Group: ${label}`;
  }
  return id;
}

export function positionIcon(position: ChatDrawerPosition) {
  switch (position) {
    case "left":
      return PanelLeftOpen;
    case "right":
      return PanelRightOpen;
    case "top":
      return PanelTopOpen;
    case "bottom":
      return PanelBottomOpen;
  }
}
