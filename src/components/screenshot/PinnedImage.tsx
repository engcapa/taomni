import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import {
  closePin,
  fetchPinInit,
  loadScreenshotUrl,
  revokeScreenshotUrl,
  type PinInit,
} from "../../lib/screenshot";

/**
 * Frameless always-on-top window showing a pinned screenshot.
 * Drag to move, double-click / right-click / Esc to close.
 */
export function PinnedImage() {
  const t = useT();
  const [init, setInit] = useState<PinInit | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: string | null = null;
    fetchPinInit()
      .then(async (pin) => {
        const objectUrl = await loadScreenshotUrl(pin.path);
        loaded = objectUrl;
        if (cancelled) {
          revokeScreenshotUrl(objectUrl);
          return;
        }
        setInit(pin);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(t("screenshot.pinLoadFailed"));
      });
    return () => {
      cancelled = true;
      revokeScreenshotUrl(loaded);
    };
  }, [t]);

  const close = async () => {
    try {
      await closePin(getCurrentWindow().label);
    } catch {
      await getCurrentWindow()
        .close()
        .catch(() => undefined);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      void close();
      return;
    }
    // detail > 1 is the second press of a double-click: let it close.
    if (e.button === 0 && e.detail === 1) {
      void getCurrentWindow()
        .startDragging()
        .catch(() => undefined);
    }
  };

  if (error) {
    return (
      <div
        className="fixed inset-0 flex items-center justify-center text-[13px] text-white bg-black/80"
        onDoubleClick={() => void close()}
      >
        {error}
      </div>
    );
  }
  if (!init || !url) return null;

  return (
    <div
      data-testid="screenshot-pin-window"
      className="fixed inset-0 select-none"
      style={{
        cursor: "move", backgroundColor: "#e2e2e2",
        backgroundImage: "conic-gradient(#c4c4c4 25%, transparent 0 50%, #c4c4c4 0 75%, transparent 0)",
        backgroundSize: "16px 16px",
      }}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => void close()}
      onContextMenu={(e) => e.preventDefault()}
      title={t("screenshot.pinHint")}
    >
      <img
        data-testid="screenshot-pin-image"
        src={url}
        alt={t("screenshot.pin")}
        className="w-full h-full block pointer-events-none object-contain"
        draggable={false}
      />
      {/* Subtle border so the pin is visible on white backgrounds. */}
      <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: "inset 0 0 0 1px rgba(22,119,255,0.6)" }} />
    </div>
  );
}
