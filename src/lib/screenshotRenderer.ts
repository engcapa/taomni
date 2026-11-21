import { listen, type EventCallback } from "@tauri-apps/api/event";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { formatUnknownError } from "./appDialogs";
import { listPlugins } from "./ipc/plugin";
import { installPluginFrontendHost } from "./pluginFrontendHost";
import { pluginFrontendUrl } from "./pluginLoader";
import { isTauriRuntime } from "./runtime";
import {
  RECORDING_ENDED_EVENT, cancelRecording, closeScreenshotOverlay, copyImageToClipboard,
  currentRecording, loadScreenshotUrl, recordingStatus, revokeScreenshotUrl, saveImageToFile,
  stopRecording,
} from "./screenshot";

const recorder = Object.freeze({
  RECORDING_ENDED_EVENT, cancelRecording, closeScreenshotOverlay, copyImageToClipboard,
  currentRecording, loadScreenshotUrl, recordingStatus, revokeScreenshotUrl, saveImageToFile,
  stopRecording,
});

const platform = Object.freeze({
  recorder,
  formatUnknownError,
  listen<T>(event: string, callback: EventCallback<T>) {
    if (event !== RECORDING_ENDED_EVENT) return Promise.reject(new Error("Unsupported recorder event"));
    return listen(event, callback);
  },
  getCurrentWindow() {
    const window = getCurrentWindow();
    return {
      setSize: (size: LogicalSize) => window.setSize(size),
      close: () => window.close(),
    };
  },
  LogicalSize,
  async save(options: Parameters<typeof import("@tauri-apps/plugin-dialog").save>[0]) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return save(options);
  },
});

declare global {
  var __taomniScreenshotHost: typeof platform | undefined;
}

export async function loadSignedScreenshotRenderer() {
  if (!isTauriRuntime()) return null;
  const record = (await listPlugins()).find((item) => item.slug === "screenshot");
  if (record?.lifecycle !== "enabled" || !record.manifest?.entry.frontend) return null;
  installPluginFrontendHost();
  if (!globalThis.__taomniScreenshotHost) {
    Object.defineProperty(globalThis, "__taomniScreenshotHost", { value: platform });
  }
  const entry = pluginFrontendUrl(record.manifest);
  const renderer = await import(/* @vite-ignore */ entry) as typeof import("../../src-tauri/plugins/screenshot/renderer");
  return { entry, renderer };
}
