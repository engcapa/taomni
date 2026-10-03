import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";

type PttState = "idle" | "supported-check" | "recording" | "transcribing" | "unsupported" | "error";

interface VoiceTranscribeResult {
  /** Recognised text from the local ASR engine. */
  transcript: string;
  duration_ms: number;
  intent_json: string | null;
}

/**
 * Push-to-talk microphone button for the title bar.
 *
 * - Hold down to record (mouse or Space-bar pressed while focused).
 * - Release to stop + transcribe.
 * - Hidden entirely when AI is fully disabled.
 *
 * The resulting transcript is staged into the ChatStore composer so the user
 * can review and send (or it can be auto-routed via voice intent dispatch
 * later — that lives in voice/intent_dispatcher and is out of UI scope).
 */
export function PttButton() {
  const t = useT();
  const [state, setState] = useState<PttState>("idle");
  const [error, setError] = useState<string | null>(null);
  const fullyDisabled = useAiStore((s) => !!s.config?.fully_disabled);
  const supportedRef = useRef<boolean | null>(null);
  const pressedRef = useRef(false);

  // One-shot capability probe so the button can grey itself out on hosts
  // that lack a working capture API (cpal feature flag off, no mic, etc.).
  useEffect(() => {
    if (fullyDisabled) return;
    if (supportedRef.current !== null) return;
    let cancelled = false;
    invoke<boolean>("voice_capture_supported")
      .then((ok) => {
        if (cancelled) return;
        supportedRef.current = ok;
        if (!ok) setState("unsupported");
      })
      .catch(() => {
        if (cancelled) return;
        supportedRef.current = false;
        setState("unsupported");
      });
    return () => { cancelled = true; };
  }, [fullyDisabled]);

  const startRecording = async () => {
    if (state !== "idle") return;
    if (supportedRef.current === false) return;
    pressedRef.current = true;
    setError(null);
    setState("recording");
    try {
      await invoke("voice_start_capture");
    } catch (e) {
      setState("error");
      setError(String(e));
      pressedRef.current = false;
    }
  };

  const stopRecording = async () => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    if (state !== "recording") return;
    setState("transcribing");
    try {
      const result = await invoke<VoiceTranscribeResult>("voice_stop_and_transcribe", {
        routeIntent: false,
      });
      const text = result.transcript.trim();
      if (text.length > 0) {
        // Stage the transcript into the chat composer for review.
        // Use a dynamic import so we don't add a hard chain to chatStore here.
        const { useChatStore } = await import("../../stores/chatStore");
        useChatStore.getState().attachToComposer(text);
      }
      setState("idle");
    } catch (e) {
      setState("error");
      setError(String(e));
    }
  };

  // Cancel on visibility loss / unmount so we don't leave the recorder armed.
  useEffect(() => {
    return () => {
      if (pressedRef.current) {
        void invoke("voice_stop_capture").catch(() => undefined);
        pressedRef.current = false;
      }
    };
  }, []);

  if (fullyDisabled) return null;

  const isUnsupported = supportedRef.current === false;
  const Icon = state === "transcribing"
    ? Loader2
    : isUnsupported
    ? MicOff
    : Mic;
  const label = isUnsupported
    ? t("ptt.micUnavailable")
    : state === "recording"
    ? t("ptt.recording")
    : state === "transcribing"
    ? t("ptt.transcribing")
    : t("ptt.holdToSpeak");

  return (
    <button
      type="button"
      title={error ? `${label}\n${error}` : label}
      aria-label={label}
      data-testid="ptt-button"
      data-state={state}
      disabled={isUnsupported}
      className={`taomni-titlebar-tray-btn h-full w-10 inline-flex items-center justify-center transition-colors ${
        state === "recording" ? "bg-red-500/30 text-red-300" : ""
      } ${isUnsupported ? "opacity-40 cursor-not-allowed" : "hover:bg-[var(--taomni-hover)]"}`}
      style={{ color: "var(--taomni-text)" }}
      onMouseDown={() => void startRecording()}
      onMouseUp={() => void stopRecording()}
      onMouseLeave={() => { if (state === "recording") void stopRecording(); }}
      onTouchStart={() => void startRecording()}
      onTouchEnd={() => void stopRecording()}
    >
      <Icon className={`w-[16px] h-[16px] ${state === "transcribing" ? "animate-spin" : ""}`} />
    </button>
  );
}
