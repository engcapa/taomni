import { useEffect, useState } from "react";
import { Check, Download, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import {
  cancelRecording,
  closeScreenshotOverlay,
  currentRecording,
  saveImageToFile,
  screenshotFileUrl,
  stopRecording,
  type ScreenshotFile,
} from "../../lib/screenshot";

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function RecorderBar() {
  const t = useT();
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [initFailed, setInitFailed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [preview, setPreview] = useState<ScreenshotFile | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    currentRecording()
      .then((id) => {
        if (cancelled) return;
        if (id) setRecordingId(id);
        else setInitFailed(true);
      })
      .catch(() => {
        if (!cancelled) setInitFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (preview || !recordingId) return;
    const timer = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [preview, recordingId]);

  const closeAll = async () => {
    try {
      await closeScreenshotOverlay();
    } catch {
      await getCurrentWindow()
        .close()
        .catch(() => undefined);
    }
  };

  const handleStop = async () => {
    if (!recordingId || stopping) return;
    setStopping(true);
    setError(null);
    try {
      const file = await stopRecording(recordingId);
      setPreview(file);
    } catch {
      setError(t("screenshot.recordFailed"));
    } finally {
      setStopping(false);
    }
  };

  const handleCancel = async () => {
    if (recordingId) {
      try {
        await cancelRecording(recordingId);
      } catch {
        // Best effort: the file is discarded regardless.
      }
    }
    await closeAll();
  };

  const handleSave = async () => {
    if (!preview) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const ext = preview.path.toLowerCase().endsWith(".mp4") ? "mp4" : "gif";
      const dest = await save({
        title: t("screenshot.save"),
        defaultPath: `taomni-recording.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (typeof dest !== "string" || !dest.trim()) return;
      await saveImageToFile(preview.path, dest);
      await closeAll();
    } catch {
      setError(t("screenshot.saveFailed"));
    }
  };

  const isMp4 = preview?.path.toLowerCase().endsWith(".mp4") ?? false;

  return (
    <div
      data-testid="screenshot-recorder"
      className="flex flex-col items-stretch gap-2 px-3 py-2 text-[13px] select-none"
      style={{
        background: "var(--taomni-panel-bg)",
        border: "1px solid var(--taomni-divider)",
        color: "var(--taomni-text)",
        borderRadius: 12,
        minWidth: 200,
      }}
    >
      {initFailed ? (
        <div className="flex flex-col gap-2 py-1">
          <p data-testid="screenshot-recorder-error" className="text-[12px]" style={{ color: "#ff6b6b" }}>
            {t("screenshot.noRecording")}
          </p>
          <button
            type="button"
            data-testid="screenshot-recorder-cancel"
            onClick={() => void handleCancel()}
            className="rounded-lg px-3 py-1.5 text-[12px] self-end"
            style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
          >
            {t("screenshot.cancel")}
          </button>
        </div>
      ) : preview ? (
        <>
          {isMp4 ? (
            <video
              data-testid="screenshot-recorder-preview"
              src={screenshotFileUrl(preview.path)}
              controls
              className="rounded-lg"
              style={{ maxWidth: 320, maxHeight: 200, background: "#000" }}
            />
          ) : (
            <img
              data-testid="screenshot-recorder-preview"
              src={screenshotFileUrl(preview.path)}
              alt=""
              className="rounded-lg"
              style={{ maxWidth: 320, maxHeight: 200 }}
            />
          )}
          {error && (
            <p data-testid="screenshot-recorder-error" className="text-[12px]" style={{ color: "#ff6b6b" }}>
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              data-testid="screenshot-recorder-save"
              onClick={() => void handleSave()}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px]"
              style={{ background: "var(--taomni-hover)", color: "var(--taomni-text)" }}
            >
              <Download size={13} />
              {t("screenshot.save")}
            </button>
            <button
              type="button"
              data-testid="screenshot-recorder-done"
              onClick={() => void closeAll()}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px]"
              style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
            >
              <Check size={13} />
              {t("screenshot.done")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full animate-pulse shrink-0"
              style={{ background: "#ff4d4f" }}
            />
            <span data-testid="screenshot-recorder-timer" className="tabular-nums font-medium">
              {formatElapsed(elapsed)}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              data-testid="screenshot-recorder-stop"
              title={t("screenshot.stop")}
              aria-label={t("screenshot.stop")}
              onClick={() => void handleStop()}
              disabled={stopping || !recordingId}
              className="w-8 h-8 rounded-lg flex items-center justify-center disabled:opacity-40"
              style={{ background: "#ff4d4f", color: "#ffffff" }}
            >
              <Square size={14} />
            </button>
            <button
              type="button"
              data-testid="screenshot-recorder-cancel"
              title={t("screenshot.cancel")}
              aria-label={t("screenshot.cancel")}
              onClick={() => void handleCancel()}
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "var(--taomni-hover)", color: "var(--taomni-text)" }}
            >
              <X size={14} />
            </button>
          </div>
          {error && (
            <p data-testid="screenshot-recorder-error" className="text-[12px]" style={{ color: "#ff6b6b" }}>
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
