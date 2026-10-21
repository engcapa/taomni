import { sha256Hex } from "../projectAnalysisModel";
import { type CodeActionContextIdentity } from "./types";

export const DEFAULT_ALLOWED_COMMAND_PREFIXES = [
  "editor.action.",
  "workspace.",
  "_java.",
  "java.",
  "rust-analyzer.",
  "typescript.",
  "eslint.",
  "quickfix.",
] as const;

export function isCommandAllowed(command: string, customAllowlist?: readonly string[]): boolean {
  if (!command || typeof command !== "string") return false;
  const allowlist = customAllowlist ?? DEFAULT_ALLOWED_COMMAND_PREFIXES;
  return allowlist.some((prefix) => command.startsWith(prefix) || command === prefix);
}

export function computeStableActionId(
  action: { title: string; kind?: string | null; },
  providerId: string,
): string {
  const hash = sha256Hex(`${providerId} ${action.kind ?? ""} ${action.title}`).slice(0, 16);
  return `codeAction.${providerId}.${hash}`;
}

export function cloneAndDeepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndDeepFreeze(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneAndDeepFreeze(item)]),
    );
    return Object.freeze(clone) as T;
  }
  return value;
}

export function snapshotCodeActionContext(context: CodeActionContextIdentity): CodeActionContextIdentity {
  return cloneAndDeepFreeze(context);
}
