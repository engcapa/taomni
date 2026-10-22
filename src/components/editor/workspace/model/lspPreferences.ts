import type { LspCustomServerCommand } from "../../../../lib/editor/lsp";
import { LSP_JAVA_HOME_KEY, LSP_JAVA_VMARGS_KEY, LSP_JAVA_HEAP_MB_KEY, LSP_JAVA_SETTINGS_KEY, LSP_JAVA_BUNDLES_KEY } from "./lspPreferenceKeys";
import { type LspCustomCommandConfig } from "./types";

export const LSP_COMMAND_PREFS_KEY = "taomni.codeWorkspace.lspCommandPrefs.v1";

export const LSP_CUSTOM_COMMANDS_KEY = "taomni.codeWorkspace.lspCustomCommands.v1";

export const CUSTOM_LSP_COMMAND_ID = "__custom__";

export const LSP_PREFS_CHANGED_EVENT = "taomni:lsp-server-prefs-changed";

export function emitLspPrefsChanged(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(LSP_PREFS_CHANGED_EVENT));
  } catch {
    // CustomEvent may be unavailable in exotic environments.
  }
}

/** Subscribe to LSP command / custom-command preference changes (Settings ↔ Workspace). */
export function subscribeLspServerPrefs(listener: () => void): () => void {
  if (typeof window === "undefined") return () => { };
  const onCustom = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (
      event.key !== null
      && event.key !== LSP_COMMAND_PREFS_KEY
      && event.key !== LSP_CUSTOM_COMMANDS_KEY
      && event.key !== LSP_JAVA_HOME_KEY
      && event.key !== LSP_JAVA_VMARGS_KEY
      && event.key !== LSP_JAVA_HEAP_MB_KEY
      && event.key !== LSP_JAVA_SETTINGS_KEY
      && event.key !== LSP_JAVA_BUNDLES_KEY
    ) {
      return;
    }
    listener();
  };
  window.addEventListener(LSP_PREFS_CHANGED_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LSP_PREFS_CHANGED_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

export function readLspCommandPrefs(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LSP_COMMAND_PREFS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLspCommandPrefs(prefs: Record<string, string>): void {
  try {
    window.localStorage.setItem(LSP_COMMAND_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
}

export function readLspCustomCommands(): Record<string, LspCustomCommandConfig> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LSP_CUSTOM_COMMANDS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, LspCustomCommandConfig> = {};
    for (const [presetId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const command = typeof (value as { command?: unknown; }).command === "string"
        ? (value as { command: string; }).command
        : "";
      const args = typeof (value as { args?: unknown; }).args === "string"
        ? (value as { args: string; }).args
        : "";
      if (command.trim() || args.trim()) out[presetId] = { command, args };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeLspCustomCommands(commands: Record<string, LspCustomCommandConfig>): void {
  try {
    window.localStorage.setItem(LSP_CUSTOM_COMMANDS_KEY, JSON.stringify(commands));
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
}

export function splitCommandArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

export function customServerCommandFromConfig(config?: LspCustomCommandConfig): LspCustomServerCommand | null {
  const command = config?.command.trim() ?? "";
  if (!command) return null;
  return {
    label: "Custom",
    command,
    args: splitCommandArgs(config?.args ?? ""),
  };
}
