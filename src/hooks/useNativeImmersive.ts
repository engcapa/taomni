import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAppPlatform, isTauriRuntime } from "../lib/runtime";

/** Native macOS traffic lights live outside the WebView's titlebar. */
export function useNativeImmersive(immersive: boolean): string | null {
  const [error, setError] = useState<string | null>(null);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    if (!isTauriRuntime() || getAppPlatform() !== "macos") return;
    let current = true;
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (!current) return;
      try {
        await getCurrentWindow().setDecorations(!immersive);
        if (current) setError(null);
      } catch (failure) {
        if (current) setError(String(failure));
      }
    });
    return () => { current = false; };
  }, [immersive]);
  return error;
}
