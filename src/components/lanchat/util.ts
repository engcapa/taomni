import type { LanPresence } from "../../types";

/** Deterministic gradient for an avatar, derived from an id/name. */
const GRADIENTS = [
  "linear-gradient(135deg,#10b981,#0ea5e9)",
  "linear-gradient(135deg,#f59e0b,#ef4444)",
  "linear-gradient(135deg,#8b5cf6,#6366f1)",
  "linear-gradient(135deg,#0ea5e9,#3b82f6)",
  "linear-gradient(135deg,#ec4899,#8b5cf6)",
  "linear-gradient(135deg,#1e40af,#3b82f6)",
  "linear-gradient(135deg,#16a34a,#10b981)",
  "linear-gradient(135deg,#f59e0b,#f97316)",
];

export function avatarGradient(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

/** First visible character of a display name, for avatar fallback. */
export function avatarInitial(name: string): string {
  return name.trim().charAt(0) || "?";
}

/** CSS color for a presence dot. */
export function presenceColor(status: LanPresence): string {
  switch (status) {
    case "online":
      return "var(--ok, #16a34a)";
    case "away":
      return "var(--away, #f59e0b)";
    case "busy":
      return "var(--busy, #ef4444)";
    default:
      return "#94a3b8";
  }
}

export function presenceLabel(status: LanPresence): string {
  switch (status) {
    case "online":
      return "在线";
    case "away":
      return "离开";
    case "busy":
      return "忙碌";
    default:
      return "离线";
  }
}

/** Compact relative-ish timestamp for list rows. */
export function shortTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Day separator label for the message thread. */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return "昨天";
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
