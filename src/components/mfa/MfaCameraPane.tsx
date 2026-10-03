import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useT } from "../../lib/i18n";
import { errorText } from "../../lib/mfa/format";
import { decodeVideoFrame } from "../../lib/mfa/qrImage";
import type { MfaTextsOutcome } from "./MfaImagePane";

export type MfaCameraState = "starting" | "scanning" | "no-camera" | "denied" | "error";
/** Delay between decoded frames (≈6 fps keeps the WebView responsive). */
export const MFA_CAMERA_FRAME_MS = 150;

/** Live camera QR scan. Every exit path stops the stream's tracks. */
export function MfaCameraPane({ onTexts }: { onTexts: (texts: string[]) => MfaTextsOutcome }) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onTextsRef = useRef(onTexts);
  onTextsRef.current = onTexts;
  const [state, setState] = useState<MfaCameraState>("starting");
  const [message, setMessage] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    canvasRef.current ??= document.createElement("canvas");

    const tick = async () => {
      const video = videoRef.current;
      if (cancelled || !stream || !video || !canvasRef.current) return;
      const text = await decodeVideoFrame(video, canvasRef.current);
      if (cancelled) return;
      if (text) {
        const outcome = onTextsRef.current([text]);
        if (outcome.ok) {
          stop();
          return;
        }
        setMessage(outcome.message);
      }
      timer = window.setTimeout(() => void tick(), MFA_CAMERA_FRAME_MS);
    };

    void (async () => {
      setState("starting");
      setMessage("");
      const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      if (!media?.getUserMedia || !media.enumerateDevices) {
        setState("no-camera");
        return;
      }
      const cameras = (await media.enumerateDevices().catch(() => [])).filter((device) => device.kind === "videoinput");
      if (cancelled) return;
      setDevices(cameras);
      if (cameras.length === 0) {
        setState("no-camera");
        return;
      }
      try {
        stream = await media.getUserMedia({
          audio: false,
          video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (err) {
        if (cancelled) return;
        const name = (err as { name?: string } | null)?.name;
        if (name === "NotAllowedError" || name === "SecurityError") setState("denied");
        else if (name === "NotFoundError" || name === "OverconstrainedError") setState("no-camera");
        else {
          setState("error");
          setMessage(errorText(err));
        }
        return;
      }
      if (cancelled) {
        stop();
        return;
      }
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      // Labels are only exposed after permission; refresh the device list.
      const labelled = (await media.enumerateDevices().catch(() => [])).filter((device) => device.kind === "videoinput");
      if (!cancelled && labelled.length > 0) setDevices(labelled);
      if (cancelled) return;
      setState("scanning");
      void tick();
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [deviceId, attempt]);

  const live = state === "starting" || state === "scanning";
  const statusText =
    state === "starting"
      ? t("mfa.cameraStarting")
      : state === "scanning"
        ? message || t("mfa.cameraScanning")
        : state === "no-camera"
          ? t("mfa.cameraNone")
          : state === "denied"
            ? t("mfa.cameraDenied")
            : t("mfa.cameraError", { error: message });

  return (
    <div className="space-y-2">
      <p className="text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>{t("mfa.cameraHint")}</p>
      {devices.length > 1 ? (
        <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
          {t("mfa.cameraDevice")}
          <select
            data-testid="mfa-camera-device"
            className="taomni-input flex-1"
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            {devices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `${t("mfa.cameraDevice")} ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="relative overflow-hidden rounded" style={{ background: "#000", display: live ? "block" : "none" }}>
        <video
          ref={videoRef}
          data-testid="mfa-camera-video"
          className="block h-[220px] w-full object-contain"
          style={{ transform: "scaleX(-1)" }}
          autoPlay
          muted
          playsInline
        />
      </div>
      <div className="flex items-center gap-2">
        <div
          data-testid="mfa-camera-state"
          data-state={state}
          role="status"
          aria-live="polite"
          className="flex-1 text-[12px]"
          style={{ color: live ? "var(--taomni-text-muted)" : "var(--taomni-error, #c33)" }}
        >
          {statusText}
        </div>
        {!live ? (
          <button
            type="button"
            data-testid="mfa-camera-retry"
            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[12px] hover:bg-[var(--taomni-hover)]"
            style={{ borderColor: "var(--taomni-input-border)" }}
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw className="h-3 w-3" />
            {t("mfa.cameraRetry")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
