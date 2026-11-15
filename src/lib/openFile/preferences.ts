import { create } from "zustand";
import type { AppProxyConfig } from "../ipc/proxy";

export type FileHandler = "taomni" | "workspace" | "system";
export interface FileOpenPreferences {
  defaultHandler: "taomni" | "system";
  associations: Record<string, FileHandler>;
  markdownImageDir: string;
  markdownImageTemplate: string;
  convertTables: boolean;
  wrap: boolean;
  fontSize: number;
  htmlNetwork: "block" | "ask";
  htmlScripts: boolean;
  htmlProxyMode: "app" | "custom" | "none";
  htmlCustomProxy: AppProxyConfig;
}
export const FILE_OPEN_PREFERENCES_KEY = "taomni.fileOpen.preferences.v1";
export const DEFAULT_FILE_OPEN_PREFERENCES: FileOpenPreferences = {
  defaultHandler: "taomni", associations: {}, markdownImageDir: "assets",
  markdownImageTemplate: "image-{date}-{time}.png", convertTables: true,
  wrap: true, fontSize: 13, htmlNetwork: "block", htmlScripts: true,
  htmlProxyMode: "app", htmlCustomProxy: { enabled: true, mode: "manual", session_id: "", kind: "http", host: "", port: 3128, username: "", password_ref: "" },
};

function validated(value: Partial<FileOpenPreferences>): FileOpenPreferences {
  const defaults = DEFAULT_FILE_OPEN_PREFERENCES;
  return {
    defaultHandler: value.defaultHandler === "system" ? "system" : "taomni",
    associations: Object.fromEntries(Object.entries(value.associations ?? {}).filter(([key, handler]) => /^[a-z0-9_-]+$/i.test(key) && ["taomni", "workspace", "system"].includes(handler))),
    markdownImageDir: typeof value.markdownImageDir === "string" && value.markdownImageDir.trim() ? value.markdownImageDir : defaults.markdownImageDir,
    markdownImageTemplate: typeof value.markdownImageTemplate === "string" && value.markdownImageTemplate.trim() ? value.markdownImageTemplate : defaults.markdownImageTemplate,
    convertTables: value.convertTables !== false,
    wrap: value.wrap !== false,
    fontSize: typeof value.fontSize === "number" && Number.isFinite(value.fontSize) ? Math.max(10, Math.min(32, value.fontSize)) : defaults.fontSize,
    htmlNetwork: value.htmlNetwork === "ask" ? "ask" : "block",
    htmlScripts: value.htmlScripts !== false,
    htmlProxyMode: value.htmlProxyMode === "custom" || value.htmlProxyMode === "none" ? value.htmlProxyMode : "app",
    htmlCustomProxy: { ...defaults.htmlCustomProxy, ...(value.htmlCustomProxy && typeof value.htmlCustomProxy === "object" ? value.htmlCustomProxy : {}), enabled: true },
  };
}
function read(): FileOpenPreferences {
  try { return validated(JSON.parse(localStorage.getItem(FILE_OPEN_PREFERENCES_KEY) ?? "{}")); }
  catch { return { ...DEFAULT_FILE_OPEN_PREFERENCES, associations: {} }; }
}
export const useFileOpenPreferences = create<FileOpenPreferences>(() => read());
export function setFileOpenPreferences(patch: Partial<FileOpenPreferences>): void {
  const next = validated({ ...useFileOpenPreferences.getState(), ...patch });
  localStorage.setItem(FILE_OPEN_PREFERENCES_KEY, JSON.stringify(next));
  useFileOpenPreferences.setState(next, true);
}
export function resetFileOpenPreferences(): void {
  setFileOpenPreferences({ ...DEFAULT_FILE_OPEN_PREFERENCES, associations: {} });
}
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === FILE_OPEN_PREFERENCES_KEY || event.key === null) useFileOpenPreferences.setState(read(), true);
});
