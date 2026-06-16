import { Square } from "lucide-react";
import { useCaptureStore } from "../../stores/captureStore";
import { useT } from "../../lib/i18n";
import { formatElapsed } from "./captureMenuItems";

// Themed "stop" pill shown while a scroll/GIF capture is in progress. The
// screenshot actions themselves now live in the tab-strip `⋯` menu, so this is
// the only always-visible affordance to finish a running capture — it must read
// clearly in both light and dark chrome (the old toolbar used hard-coded dark
// colours that washed out on the light theme).
function pillStyle(accent: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    height: 24,
    padding: "0 8px",
    borderRadius: 4,
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
    color: accent,
    border: `1px solid ${accent}`,
    background: `color-mix(in srgb, ${accent} 14%, transparent)`,
    fontVariantNumeric: "tabular-nums",
  };
}

/**
 * Renders the active scroll/GIF capture "Stop" pills into the chrome. Mounted
 * wherever a running capture should stay reachable (the main ControlBar and the
 * detached-window bar). Renders nothing when idle.
 */
export function CaptureIndicators() {
  const t = useT();
  const scrolling = useCaptureStore((s) => s.scroller !== null);
  const recording = useCaptureStore((s) => s.recorder !== null);
  const scrollFrames = useCaptureStore((s) => s.scrollFrames);
  const elapsed = useCaptureStore((s) => s.elapsed);
  const toggleScroll = useCaptureStore((s) => s.toggleScroll);
  const toggleGif = useCaptureStore((s) => s.toggleGif);

  if (!scrolling && !recording) return null;

  return (
    <div className="flex items-center gap-1 shrink-0">
      {scrolling && (
        <button
          type="button"
          data-testid="capture-stop-scroll"
          onClick={toggleScroll}
          style={pillStyle("#5cb8ff")}
          title={t("capture.stopScroll")}
        >
          <Square size={14} />
          <span>{t("capture.scrollFramesLabel", { count: scrollFrames })}</span>
        </button>
      )}
      {recording && (
        <button
          type="button"
          data-testid="capture-stop-gif"
          onClick={toggleGif}
          style={pillStyle("#ff5050")}
          title={t("capture.stopGif")}
        >
          <Square size={14} />
          <span>{formatElapsed(elapsed)}</span>
        </button>
      )}
    </div>
  );
}
