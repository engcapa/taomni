import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Square, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import { formatUnknownError } from "../../lib/appDialogs";
import {
  RECORDING_ENDED_EVENT,
  cancelRecording,
  closeScreenshotOverlay,
  copyImageToClipboard,
  currentRecording,
  recordingStatus,
  loadScreenshotUrl,
  revokeScreenshotUrl,
  saveImageToFile,
  stopRecording,
  type RecordingFile,
} from "../../lib/screenshot";

export function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Small always-on-top window controlling a running recording: timer, stop,
 * cancel; after stop a preview with save / copy (GIF) / done.
 */
export function RecorderBar() {
  const t = useT();
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [initFailed, setInitFailed] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [preview, setPreview] = useState<RecordingFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBytes, setPreviewBytes] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [range, setRange] = useState<string | null>(null);
  const stopRef = useRef(false);
  const mountedRef = useRef(false);
  const closingRef = useRef(false);
  const previewRequestRef = useRef(0);
  const previewUrlRef = useRef<string | null>(null);

  const isActive = useCallback(() => mountedRef.current && !closingRef.current, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewRequestRef.current++;
      revokeScreenshotUrl(previewUrlRef.current);
      previewUrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    currentRecording()
      .then((id) => {
        if (cancelled || !isActive()) return;
        if (id) {
          setRecordingId(id);
          setStartedAt(Date.now());
        } else setInitFailed(true);
      })
      .catch(() => {
        if (!cancelled && isActive()) setInitFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isActive]);

  useEffect(() => {
    if (preview || !recordingId || stopping) return;
    const timer = window.setInterval(() => {
      if (isActive()) setNow(Date.now());
    }, 250);
    return () => window.clearInterval(timer);
  }, [preview, recordingId, stopping, isActive]);

  useEffect(() => {
    if (preview || !isActive() || !(initFailed || stopping || notice || error)) return;
    void getCurrentWindow().setSize(new LogicalSize(360, 140)).catch(() => undefined);
  }, [preview, initFailed, stopping, notice, error, isActive]);

  const closeAll = useCallback(async () => {
    closingRef.current = true;
    previewRequestRef.current++;
    revokeScreenshotUrl(previewUrlRef.current);
    previewUrlRef.current = null;
    try {
      await closeScreenshotOverlay();
    } catch {
      await getCurrentWindow()
        .close()
        .catch(() => undefined);
    }
  }, []);

  const showPreview = useCallback(async (file: RecordingFile) => {
    if (!isActive()) return;
    const request = ++previewRequestRef.current;
    const isCurrent = () => isActive() && request === previewRequestRef.current;
    revokeScreenshotUrl(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setPreviewBytes(0);
    setPreview(file);
    try {
      await getCurrentWindow()
        .setSize(new LogicalSize(380, 300))
        .catch(() => undefined);
      if (!isCurrent()) return;
      const url = await loadScreenshotUrl(file.path);
      if (!isCurrent()) {
        revokeScreenshotUrl(url);
        return;
      }
      previewUrlRef.current = url;
      setPreviewUrl(url);
      if (url.startsWith("blob:")) {
        // Some native WebViews allow blob media playback but reject Fetch
        // on the same URL. Optional size metadata must not fail the preview.
        try {
          const blob = await fetch(url).then((r) => r.blob());
          if (isCurrent()) setPreviewBytes(blob.size);
        } catch {
          // The media element still owns decode/playback error reporting.
        }
      }
    } catch (e) {
      if (isCurrent()) setError(formatUnknownError(e));
    }
  }, [isActive]);

  const handleStop = useCallback(async () => {
    if (!recordingId || stopRef.current || !isActive()) return;
    stopRef.current = true;
    setStopping(true);
    setError(null);
    try {
      await showPreview(await stopRecording(recordingId));
    } catch (e) {
      if (isActive()) {
        // Finalization consumes the backend session even when it fails.
        // Leave Cancel available, but never retry Stop for this id.
        setRecordingId(null);
        setError(t("screenshot.recordFailed", { error: formatUnknownError(e) }));
      }
    } finally {
      if (isActive()) setStopping(false);
    }
  }, [recordingId, showPreview, t, isActive]);

  // The backend stops on its own at the time limit (or on failure).
  useEffect(() => {
    if (!recordingId) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<{ recordingId: string; error: string | null; stoppedByUser?: boolean }>(RECORDING_ENDED_EVENT, (event) => {
      if (disposed || !isActive() || stopRef.current || event.payload.recordingId !== recordingId) return;
      if (event.payload.error) setNotice(event.payload.error);
      else if (!event.payload.stoppedByUser) setNotice(t("screenshot.recordLimitReached"));
      void handleStop();
    }).then(async (fn) => {
      if (disposed) fn();
      else {
        unlisten = fn;
        const status = await recordingStatus();
        if (disposed || !isActive() || status?.recordingId !== recordingId) return;
        if (status.region) setRange(`${status.region.width} × ${status.region.height}`);
        if (status.finished && !stopRef.current) {
          if (!status.stoppedByUser) setNotice(t("screenshot.recordLimitReached"));
          void handleStop();
        }
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [recordingId, handleStop, t, isActive]);

  const handleCancel = async () => {
    if (!isActive()) return;
    closingRef.current = true;
    previewRequestRef.current++;
    if (recordingId && !preview && !stopRef.current) {
      stopRef.current = true;
      await cancelRecording(recordingId).catch(() => undefined);
    }
    await closeAll();
  };

  const isMp4 = preview?.path.toLowerCase().endsWith(".mp4") ?? false;

  const handleSave = async () => {
    if (!preview || !isActive()) return;
    setError(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      if (!isActive()) return;
      const ext = isMp4 ? "mp4" : "gif";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dest = await save({
        title: t("screenshot.save"),
        defaultPath: `Taomni-recording-${stamp}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!isActive() || typeof dest !== "string" || !dest.trim()) return;
      await saveImageToFile(preview.path, dest);
      if (isActive()) await closeAll();
    } catch (e) {
      if (isActive()) setError(t("screenshot.saveFailed", { error: formatUnknownError(e) }));
    }
  };

  const handleCopyGif = async () => {
    if (!preview || !isActive()) return;
    setError(null);
    try {
      // The clipboard has no animated-image type; copy the first frame.
      await copyImageToClipboard(preview.path);
      if (isActive()) setNotice(t("screenshot.copiedFirstFrame"));
    } catch (e) {
      if (isActive()) setError(t("screenshot.copyFailed", { error: formatUnknownError(e) }));
    }
  };

  const elapsed = startedAt !== null ? Math.max(0, (now - startedAt) / 1000) : 0;

  return (
    <div
      data-testid="screenshot-recorder"
      className="fixed inset-0 flex flex-col items-stretch gap-2 px-3 py-2 text-[13px] select-none overflow-x-hidden overflow-y-auto break-words"
      style={{
        background: "var(--taomni-panel-bg)",
        border: "1px solid var(--taomni-divider)",
        color: "var(--taomni-text)",
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
          <div className="flex-1 min-h-0 flex items-center justify-center rounded-lg overflow-hidden" style={{ background: "#000" }}>
            {previewUrl &&
              (isMp4 ? (
                <video
                  data-testid="screenshot-recorder-preview"
                  src={previewUrl}
                  controls
                  autoPlay
                  loop
                  muted
                  className="max-w-full max-h-full"
                />
              ) : (
                <img data-testid="screenshot-recorder-preview" src={previewUrl} alt="" className="max-w-full max-h-full object-contain" />
              ))}
          </div>
          <p data-testid="screenshot-recorder-meta" className="text-[11px] text-[var(--taomni-text-muted)]">
            {`${preview.width}×${preview.height} · ${formatElapsed(preview.durationMs / 1000)} · ${preview.frames} ${t("screenshot.frames")}${
              previewBytes ? ` · ${formatSize(previewBytes)}` : ""
            }`}
          </p>
          {notice && <p data-testid="screenshot-recorder-notice" className="text-[11px] text-[var(--taomni-text-muted)]">{notice}</p>}
          {error && (
            <p data-testid="screenshot-recorder-error" className="text-[12px]" style={{ color: "#ff6b6b" }}>
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            {!isMp4 && (
              <button
                type="button"
                data-testid="screenshot-recorder-copy"
                onClick={() => void handleCopyGif()}
                className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px]"
                style={{ background: "var(--taomni-hover)", color: "var(--taomni-text)" }}
              >
                <Copy size={13} />
                {t("screenshot.copy")}
              </button>
            )}
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
          <p data-testid="screenshot-recorder-range-hint" className="text-[11px] text-[var(--taomni-text-muted)]">{range ? `${range} · ` : ""}{t("screenshot.recordingRangeHint")}</p>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full animate-pulse shrink-0" style={{ background: "#ff4d4f" }} />
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
              disabled={stopping || stopRef.current || !recordingId}
              className="h-8 px-2 gap-1 rounded-lg flex items-center justify-center disabled:opacity-40"
              style={{ background: "#ff4d4f", color: "#ffffff" }}
            >
              <Square size={14} />
              {t("screenshot.stopRecording")}
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
          {stopping && <p className="text-[12px] text-[var(--taomni-text-muted)]">{t("screenshot.recordFinishing")}</p>}
          {notice && <p data-testid="screenshot-recorder-notice" className="text-[11px] text-[var(--taomni-text-muted)]">{notice}</p>}
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
