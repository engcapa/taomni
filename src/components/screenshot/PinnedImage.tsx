import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { screenshotFileUrl } from "../../lib/screenshot";

interface PinInit {
  path: string;
  width: number;
  height: number;
}

/**
 * Frameless always-on-top window showing a pinned screenshot.
 * Drag to move, double-click or Esc to close.
 */
export function PinnedImage() {
  const [init, setInit] = useState<PinInit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<PinInit>("screenshot_pin_init")
      .then(setInit)
      .catch(() => setError("Failed to load pinned image"));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void closePin();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const closePin = async () => {
    try {
      const label = getCurrentWindow().label;
      await invoke("screenshot_close_pin", { label });
    } catch {
      // Fall back to closing directly.
      await getCurrentWindow().close().catch(() => undefined);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // Right-click closes; left-drag moves the window.
    if (e.button === 2) {
      void closePin();
      return;
    }
    if (e.button === 0) {
      void getCurrentWindow().startDragging().catch(() => undefined);
    }
  };

  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center text-[13px] text-white bg-black/80">
        {error}
      </div>
    );
  }
  if (!init) return null;

  return (
    <div
      data-testid="screenshot-pin-window"
      className="fixed inset-0 select-none"
      style={{ cursor: "move" }}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => void closePin()}
      onContextMenu={(e) => e.preventDefault()}
      title="Drag to move · Double-click or right-click to close"
    >
      <img
        src={screenshotFileUrl(init.path)}
        alt="Pinned screenshot"
        className="w-full h-full block pointer-events-none"
        draggable={false}
      />
      {/* Subtle border so the pin is visible on white backgrounds. */}
      <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.25)" }} />
    </div>
  );
}
