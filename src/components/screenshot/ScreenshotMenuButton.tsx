import { useEffect, useRef, useState } from "react";
import { Camera, ChevronDown } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useAppDialogs, formatUnknownError } from "../../lib/appDialogs";
import { openScreenshotOverlay } from "../../lib/screenshot";
import { CURRENT_WINDOW_SCREENSHOT_SHORTCUT_LABEL, screenshotShortcutLabel, useScreenshotShortcutStore } from "../../lib/screenshotShortcut";
import { ContextMenu } from "../ContextMenu";
import { IconButton } from "../ui/IconButton";
import { ScreenshotFavorites } from "./ScreenshotFavorites";

/** Unified screen capture entry shared by the main and detached windows. */
export function ScreenshotMenuButton({ variant = "titlebar" }: { variant?: "titlebar" | "rail" } = {}) {
  const t = useT();
  const dialogs = useAppDialogs();
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [screenshotDelayMenu, setScreenshotDelayMenu] = useState<{ x: number; y: number } | null>(null);
  const [screenshotCountdown, setScreenshotCountdown] = useState<number | null>(null);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const countdownTimer = useRef<number | null>(null);
  const delayButton = useRef<HTMLButtonElement>(null);
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

  const handleScreenshot = async (includeCurrentWindow = false) => {
    if (screenshotBusy) return;
    setScreenshotDelayMenu(null);
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
    setScreenshotDelayMenu(null);
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
      <div className={variant === "rail"
        ? "relative w-full shrink-0 flex flex-col items-center"
        : "relative shrink-0 self-center flex items-center"}>
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
          className={variant === "rail"
            ? "h-8 w-full shrink-0 inline-flex items-center justify-center rounded-md hover:bg-[var(--taomni-hover)] disabled:opacity-50"
            : "h-6 w-7 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-50 self-center"}
        >
          {screenshotCountdown !== null ? (
            <span className="text-ui-body font-semibold tabular-nums" data-testid="system-screenshot-countdown">
              {screenshotCountdown}
            </span>
          ) : (
            <Camera className="w-4 h-4" />
          )}
        </button>
        <IconButton
          type="button"
          data-testid="system-screenshot-delay-toggle"
          label={t("screenshot.captureOptions")}
          ref={delayButton}
          disabled={screenshotBusy || screenshotCountdown !== null}
          aria-expanded={!!screenshotDelayMenu}
          aria-haspopup="menu"
          onClick={(event) => {
            const button = event.currentTarget;
            const bounds = button.getBoundingClientRect();
            button.focus({ preventScroll: true });
            setScreenshotDelayMenu(screenshotDelayMenu ? null : {
              x: variant === "rail" ? bounds.right + 4 : bounds.left,
              y: variant === "rail" ? bounds.top : bounds.bottom + 4,
            });
          }}
          className={variant === "rail"
            ? "absolute bottom-0 right-0.5 h-3 w-3 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-50"
            : "h-6 w-4 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-50"}
        >
          <ChevronDown className="w-3 h-3" />
        </IconButton>
        {screenshotDelayMenu && (
          <ContextMenu
            {...screenshotDelayMenu}
            testId="system-screenshot-delay-menu"
            ariaLabel={t("screenshot.captureOptions")}
            anchorRef={delayButton}
            closeOnTab
            dismissOnFocusOut
            onClose={() => setScreenshotDelayMenu(null)}
            items={[
              { testId: "system-screenshot-current-window", label: t("screenshot.currentWindow"),
                shortcut: `(${CURRENT_WINDOW_SCREENSHOT_SHORTCUT_LABEL})`, onClick: () => void handleScreenshot(true) },
              { testId: "system-screenshot-default-hint", label: t("screenshot.defaultHide"), sectionHeader: true },
              ...[3, 5, 10].map((seconds) => ({
                testId: `system-screenshot-delay-${seconds}`,
                label: t("screenshot.delaySeconds", { count: seconds }),
                onClick: () => handleDelayedScreenshot(seconds),
              })),
              { label: "", separator: true },
              { testId: "system-screenshot-favorites", label: t("screenshot.favorites"), onClick: () => setFavoritesOpen(true) },
            ]}
          />
        )}
        {favoritesOpen && <ScreenshotFavorites returnFocus={delayButton.current} onClose={() => setFavoritesOpen(false)} />}
      </div>
  );
}
