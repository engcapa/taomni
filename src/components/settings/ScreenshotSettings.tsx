import { useEffect, useState } from "react";
import { Camera } from "lucide-react";
import { useT } from "../../lib/i18n";
import { formatUnknownError } from "../../lib/appDialogs";
import { getAppPlatform, isTauriRuntime } from "../../lib/runtime";
import { acceleratorFromEvent, formatAccelerator, probeScreenshot, type ScreenshotProbe } from "../../lib/screenshot";
import { useScreenshotShortcutStore } from "../../lib/screenshotShortcut";

const IS_MAC = getAppPlatform() === "macos";

/** Screenshot hotkey recorder + capability summary. */
export function ScreenshotSettings() {
  const t = useT();
  const status = useScreenshotShortcutStore((s) => s.status);
  const refresh = useScreenshotShortcutStore((s) => s.refresh);
  const update = useScreenshotShortcutStore((s) => s.update);
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ScreenshotProbe | null>(null);

  useEffect(() => {
    void refresh();
    if (isTauriRuntime()) {
      probeScreenshot()
        .then(setProbe)
        .catch(() => setProbe(null));
    }
  }, [refresh]);

  const apply = async (accelerator: string | null) => {
    setError(null);
    try {
      await update(accelerator);
    } catch (e) {
      setError(formatUnknownError(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(false);
      setPending(null);
      return;
    }
    const accelerator = acceleratorFromEvent(e);
    if (!accelerator) return;
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !/^F\d+$/.test(e.code)) {
      setError(t("settings.screenshotNeedsModifier"));
      return;
    }
    setPending(accelerator);
    setRecording(false);
    void apply(accelerator).finally(() => setPending(null));
  };

  const shown = pending ?? (status.enabled ? status.accelerator : "");
  const label = shown ? formatAccelerator(shown, IS_MAC) : t("settings.screenshotDisabled");
  const native = isTauriRuntime();

  return (
    <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
      <div className="mb-3 flex items-center gap-3">
        <Camera className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div>
          <div className="text-[14px] font-semibold">{t("settings.screenshotTitle")}</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)]">{t("settings.screenshotSubtitle")}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span id="screenshot-shortcut-label" className="text-[12px] font-medium text-[var(--taomni-text-muted)]">
          {t("settings.screenshotShortcut")}
        </span>
        <button
          type="button"
          data-testid="settings-screenshot-shortcut"
          aria-labelledby="screenshot-shortcut-label"
          aria-pressed={recording}
          onClick={() => {
            setError(null);
            setRecording((v) => !v);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setRecording(false)}
          className="taomni-input h-8 min-w-40 px-3 text-left font-mono text-[13px]"
          style={recording ? { outline: "2px solid var(--taomni-accent)" } : undefined}
        >
          {recording ? t("settings.screenshotPressKeys") : label}
        </button>
        <button
          type="button"
          data-testid="settings-screenshot-shortcut-reset"
          onClick={() => void apply(null)}
          className="h-8 rounded px-3 text-[12px] hover:bg-[var(--taomni-hover)] border border-[var(--taomni-divider)]"
        >
          {t("settings.screenshotReset", { shortcut: formatAccelerator(status.defaultAccelerator, IS_MAC) })}
        </button>
        <button
          type="button"
          data-testid="settings-screenshot-shortcut-disable"
          onClick={() => void apply("")}
          disabled={!status.enabled}
          className="h-8 rounded px-3 text-[12px] hover:bg-[var(--taomni-hover)] border border-[var(--taomni-divider)] disabled:opacity-40"
        >
          {t("settings.screenshotDisable")}
        </button>
      </div>
      <p data-testid="settings-screenshot-shortcut-status" className="mt-2 text-[12px] text-[var(--taomni-text-muted)]">
        {!status.enabled
          ? t("settings.screenshotStatusDisabled")
          : !native
            ? t("settings.screenshotStatusAppOnly")
            : status.registered
              ? t("settings.screenshotStatusGlobal")
              : t("settings.screenshotStatusFallback", { error: status.error ?? "" })}
      </p>
      {error && (
        <p data-testid="settings-screenshot-shortcut-error" role="alert" className="mt-1 text-[12px]" style={{ color: "#ff6b6b" }}>
          {error}
        </p>
      )}
      {probe && (
        <p data-testid="settings-screenshot-probe" className="mt-2 text-[12px] text-[var(--taomni-text-muted)]">
          {probe.summary}
        </p>
      )}
    </section>
  );
}
