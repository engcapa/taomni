import { type VncStructuredError } from "./model";

export const VNC_STAGES = new Set<VncStructuredError["stage"]>([
  "dns",
  "tcp",
  "proxy",
  "rfb",
  "security",
  "authentication",
  "initialization",
  "runtime",
  "relay",
]);

export const MAX_FRAMEBUFFER_DIMENSION = 16_384;

export const MAX_FRAMEBUFFER_BYTES = 256 * 1024 * 1024;

export const MAX_RELAY_TEXT_CHARS = 64 * 1024 * 1024;

export const MAX_CLIPBOARD_FORMAT_CHARS = 16 * 1024 * 1024;

export const MAX_CLIPBOARD_TOTAL_CHARS = 32 * 1024 * 1024;

export const MAX_CURSOR_DIMENSION = 512;

export const MAX_CURSOR_BASE64_CHARS = 2 * 1024 * 1024;

export function isVncStage(value: unknown): value is VncStructuredError["stage"] {
  return typeof value === "string" && VNC_STAGES.has(value as VncStructuredError["stage"]);
}

export function validFramebufferSize(width: unknown, height: unknown): width is number {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  const w = width as number;
  const h = height as number;
  return w > 0
    && h > 0
    && w <= MAX_FRAMEBUFFER_DIMENSION
    && h <= MAX_FRAMEBUFFER_DIMENSION
    && w * h * 4 <= MAX_FRAMEBUFFER_BYTES;
}

export function validClipboardFormats(...formats: unknown[]): boolean {
  let total = 0;
  for (const format of formats) {
    if (format === undefined) continue;
    if (typeof format !== "string" || format.length > MAX_CLIPBOARD_FORMAT_CHARS) return false;
    total += format.length;
    if (total > MAX_CLIPBOARD_TOTAL_CHARS) return false;
  }
  return true;
}

export function parseVncError(value: unknown): VncStructuredError {
  const text = value instanceof Error ? value.message : String(value);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const error = parsed as Record<string, unknown>;
      if (typeof error.code === "string" && error.code.length <= 128
        && isVncStage(error.stage)
        && typeof error.retryable === "boolean"
        && typeof error.message === "string" && error.message.length <= 2048) {
        return error as unknown as VncStructuredError;
      }
    }
  } catch {
    // Legacy backend error; retain a sanitized generic shape.
  }
  return { code: "vnc-error", stage: "runtime", retryable: false, message: text.slice(0, 2048) };
}

export function validStats(msg: Record<string, unknown>): boolean {
  const shortText = (value: unknown) => typeof value === "string" && value.length <= 128;
  const optionalText = (value: unknown) => value === undefined || shortText(value);
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  return shortText(msg.requested_encoding)
    && optionalText(msg.quality)
    && optionalText(msg.quality_level)
    && shortText(msg.last_encoding)
    && shortText(msg.pixel_format)
    && finite(msg.wire_kbps)
    && (msg.line_kbps === null || finite(msg.line_kbps))
    && finite(msg.updates_per_sec)
    && finite(msg.frames_per_sec)
    && finite(msg.update_ms);
}
