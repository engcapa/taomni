import { invoke } from "@tauri-apps/api/core";

export const CHAT_MAX_ATTACHMENTS = 10;
export const CHAT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export type ChatAttachmentKind = "image" | "file" | "video";

export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  path: string;
  name: string;
  size: number;
  mime?: string | null;
  preview_url?: string | null;
}

export async function pickChatAttachmentPaths(): Promise<string[]> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Attach files",
    });
    if (Array.isArray(selected)) return selected.filter((value): value is string => typeof value === "string");
    return typeof selected === "string" ? [selected] : [];
  } catch {
    return [];
  }
}

export async function statChatAttachmentPaths(paths: string[]): Promise<ChatAttachment[]> {
  const unique = uniquePaths(paths);
  if (unique.length === 0) return [];
  return await invoke<ChatAttachment[]>("chat_stat_attachment_paths", { paths: unique });
}

export function mergeChatAttachments(
  current: ChatAttachment[],
  incoming: ChatAttachment[],
): { attachments: ChatAttachment[]; error: "too_many" | "too_large" | null } {
  const seen = new Set(current.map((att) => att.path));
  const uniqueIncoming = incoming.filter((att) => {
    if (!att.path || seen.has(att.path)) return false;
    seen.add(att.path);
    return true;
  });
  const next = [...current, ...uniqueIncoming];
  if (next.length > CHAT_MAX_ATTACHMENTS) {
    return { attachments: current, error: "too_many" };
  }
  if (totalAttachmentBytes(next) > CHAT_MAX_ATTACHMENT_BYTES) {
    return { attachments: current, error: "too_large" };
  }
  return { attachments: next, error: null };
}

export function totalAttachmentBytes(attachments: ChatAttachment[]): number {
  return attachments.reduce((sum, att) => sum + Math.max(0, att.size || 0), 0);
}

export function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fixed = value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[unit]}`;
}

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const clean = typeof path === "string" ? path.trim() : "";
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}
