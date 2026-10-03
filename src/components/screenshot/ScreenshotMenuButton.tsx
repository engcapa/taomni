import { useEffect, useRef, useState } from "react";
import { Camera, ChevronDown } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useAppDialogs, formatUnknownError } from "../../lib/appDialogs";
import { openScreenshotOverlay } from "../../lib/screenshot";
import { screenshotShortcutLabel, useScreenshotShortcutStore } from "../../lib/screenshotShortcut";

/** Unified screen capture entry shared by the main and detached windows. */
export function ScreenshotMenuButton() {
  const t = useT();
  const dialogs = useAppDialogs();
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [screenshotDelayMenu, setScreenshotDelayMenu] = useState(false);
  const [screenshotCountdown, setScreenshotCountdown] = useState<number | null>(null);
  const countdownTimer = useRef<number | null>(null);
  const delayMenuRef = useRef<HTMLDivElement | null>(null);
  const shortcutLabel = screenshotShortcutLabel(useScreenshotShortcutStore((s) => s.status));

  const clearScreenshotCountdown = () => {
    if (countdownTimer.current !== null) {
      window.clearInterval(countdownTimer.current);
      countdownTimer.current = null;
    }
    setScreenshotCountdown(null);
  };

  useEffect(() => {
    return () => {
      if (countdownTimer.current !== null) window.clearInterval(countdownTimer.current);
    };
  }, []);

  // Close the delay menu on outside click / Escape.
  useEffect(() => {
    if (!screenshotDelayMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!delayMenuRef.current?.contains(e.target as Node)) setScreenshotDelayMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setScreenshotDelayMenu(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [screenshotDelayMenu]);

  const handleScreenshot = async (includeCurrentWindow = false) => {
    if (screenshotBusy) return;
    setScreenshotDelayMenu(false);
    setScreenshotBusy(true);
    try {
      await openScreenshotOverlay(undefined, includeCurrentWindow);
    } catch (err) {
      await dialogs.alert({
        title: t("screenshot.tooltip"),
        message: t("screenshot.openFailed", { error: formatUnknownError(err) }),
        tone: "error",
      });
    } finally {
      setScreenshotBusy(false);
    }
  };

  /** Timed screenshot: count down, then open the overlay for capture. */
  const handleDelayedScreenshot = (seconds: number) => {
    setScreenshotDelayMenu(false);
    if (screenshotBusy || screenshotCountdown !== null) return;
    clearScreenshotCountdown();
    let remaining = seconds;
    setScreenshotCountdown(remaining);
    countdownTimer.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setScreenshotCountdown(remaining);
        return;
      }
      clearScreenshotCountdown();
      void handleScreenshot();
    }, 1000);
  };
  return (
      <div ref={delayMenuRef} className="relative shrink-0 self-center flex items-center">
        <button
          type="button"
          data-testid="system-screenshot"
          aria-label={t("screenshot.tooltip")}
          title={
            screenshotCountdown !== null
              ? t("screenshot.cancelCountdown")
              : shortcutLabel
                ? `${t("screenshot.tooltip")} (${shortcutLabel})`
                : t("screenshot.tooltip")
          }
          disabled={screenshotBusy && screenshotCountdown === null}
          onClick={() => {
            if (screenshotCountdown !== null) clearScreenshotCountdown();
            else void handleScreenshot();
          }}
          className="h-6 w-7 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-50 self-center"
        >
          {screenshotCountdown !== null ? (
            <span className="text-[12px] font-semibold tabular-nums" data-testid="system-screenshot-countdown">
              {screenshotCountdown}
            </span>
          ) : (
            <Camera className="w-4 h-4" />
          )}
        </button>
        <button
          type="button"
          data-testid="system-screenshot-delay-toggle"
          aria-label={t("screenshot.captureOptions")}
          title={t("screenshot.captureOptions")}
          disabled={screenshotBusy || screenshotCountdown !== null}
          aria-expanded={screenshotDelayMenu}
          aria-haspopup="menu"
          onClick={() => setScreenshotDelayMenu((v) => !v)}
          className="h-6 w-4 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-50"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
        {screenshotDelayMenu && (
          <div
            data-testid="system-screenshot-delay-menu"
            role="menu"
            className="absolute right-0 top-7 z-50 min-w-48 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] py-1 shadow-xl"
          >
            <button type="button" data-testid="system-screenshot-current-window" role="menuitem" onClick={() => void handleScreenshot(true)}
              className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--taomni-hover)]">{t("screenshot.currentWindow")}</button>
            <p data-testid="system-screenshot-default-hint" className="px-3 pb-1 text-[11px] text-[var(--taomni-text-muted)]">{t("screenshot.defaultHide")}</p>
            {[3, 5, 10].map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`system-screenshot-delay-${s}`}
                role="menuitem"
                onClick={() => handleDelayedScreenshot(s)}
                className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
              >
                {t("screenshot.delaySeconds", { count: s })}
              </button>
            ))}
          </div>
        )}
      </div>
  );
}
