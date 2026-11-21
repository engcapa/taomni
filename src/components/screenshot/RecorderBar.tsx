import { useEffect, useState, type ComponentType } from "react";
import { formatUnknownError } from "../../lib/appDialogs";
import { useT } from "../../lib/i18n";
import { closeScreenshotOverlay } from "../../lib/screenshot";
import { loadSignedScreenshotRenderer } from "../../lib/screenshotRenderer";

export function RecorderBar() {
  const t = useT();
  const [loaded, setLoaded] = useState<{ View: ComponentType<{ signedRenderer?: boolean }>; signed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    async function mount() {
      const signed = await loadSignedScreenshotRenderer();
      if (signed?.renderer.recorderEntry === "recorder.js") {
        const entry = new URL(signed.renderer.recorderEntry, signed.entry).href;
        const recorder = await import(/* @vite-ignore */ entry) as typeof import("../../../src-tauri/plugins/screenshot/renderer/RecorderBar");
        if (typeof recorder.RecorderBar !== "function") throw new Error("The Screenshot module has no recorder view.");
        return { View: recorder.RecorderBar, signed: true };
      }
      if (__TAOMNI_BUNDLED_SCREENSHOT_MEDIA__) {
        const { RecorderBar } = await import("../../../src-tauri/plugins/screenshot/renderer/RecorderBar");
        return { View: RecorderBar, signed: false };
      }
      throw new Error("Install or update the Screenshot module in Settings → Module Store.");
    }
    void mount().then((component) => {
      if (current) setLoaded(component);
    }).catch((failure) => {
      if (current) setError(formatUnknownError(failure));
    });
    return () => { current = false; };
  }, []);
  if (loaded) {
    const { View, signed } = loaded;
    return <View signedRenderer={signed} />;
  }
  if (!error) return null;
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 p-3">
      <p role="alert">{error}</p>
      <button type="button" onClick={() => void closeScreenshotOverlay()}>{t("common.close")}</button>
    </div>
  );
}
