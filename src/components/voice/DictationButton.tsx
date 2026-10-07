import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Mic, Square, Loader2, X } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { AsrPanel } from "../settings/AsrPanel";

type Phase = "idle" | "preparing" | "recording" | "transcribing";
type Target = HTMLInputElement | HTMLTextAreaElement;
interface Props {
  targetRef?: RefObject<Target | null>;
  onText?: (value: string) => void;
  onTranscript?: (text: string) => void;
  contextKey?: string | null;
  disabled?: boolean;
  testId?: string;
}

/** Local dictation shared by chat and text consumers; never sends or executes. */
export function DictationButton({ targetRef, onText, onTranscript, contextKey, disabled, testId = "dictation-button" }: Props) {
  const t = useT();
  const fullyDisabled = useAiStore((s) => !!s.config?.fully_disabled);
  const active = useAiStore((s) => s.config?.asr?.active ?? "whisper-base");
  const language = useAiStore((s) => s.config?.asr?.language);
  const finishing = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  const session = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const cancel = useCallback(() => {
    const id = session.current;
    session.current = null;
    finishing.current = false;
    clearTimeout(timer.current);
    if (id) void invoke("voice_stop_capture", { sessionId: id }).catch(() => undefined);
    if (mounted.current) setPhase("idle");
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  useEffect(() => { cancel(); }, [contextKey, active, language, fullyDisabled, disabled, cancel]);
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
    };
  }, [cancel]);

  const finish = async (id: string) => {
    if (session.current !== id || finishing.current) return;
    finishing.current = true;
    clearTimeout(timer.current);
    setPhase("transcribing");
    try {
      const result = await invoke<{ transcript: string }>("voice_stop_and_transcribe", { sessionId: id });
      if (session.current !== id || !mounted.current) return;
      const transcript = result.transcript.trim();
      if (!transcript) { setError(t("voice.noSpeech")); return; }
      const target = targetRef?.current;
      if (targetRef) {
        if (!target?.isConnected || target.disabled || target.readOnly) return;
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? start;
        // Read the current draft so typing during transcription is preserved.
        const next = target.value.slice(0, start) + transcript + target.value.slice(end);
        onText?.(next);
        requestAnimationFrame(() => {
          if (target.isConnected) { target.focus(); target.setSelectionRange(start + transcript.length, start + transcript.length); }
        });
      } else { onTranscript?.(transcript); }
    } catch (e) {
      if (session.current === id && mounted.current) setError(String(e));
    } finally {
      if (session.current === id) { session.current = null; if (mounted.current) setPhase("idle"); }
    }
  };
  const start = async () => {
    if (disabled || fullyDisabled || session.current) return;
    const id = crypto.randomUUID();
    session.current = id;
    finishing.current = false;
    setError("");
    setPhase("preparing");
    try {
      if (!await invoke<boolean>("voice_capture_supported")) throw new Error(t("voice.unsupported"));
      const models = await invoke<{ id: string; installed: boolean }[]>("voice_models");
      if (session.current !== id) return;
      if (!models.find((m) => m.id === active)?.installed) {
        session.current = null;
        setPhase("idle");
        setSetup(true);
        return;
      }
      await invoke("voice_start_capture", { sessionId: id });
      if (session.current !== id) {
        void invoke("voice_stop_capture", { sessionId: id }).catch(() => undefined);
        return;
      }
      setPhase("recording");
      timer.current = setTimeout(() => void finish(id), 120_000);
    } catch (e) {
      if (session.current === id && mounted.current) {
        session.current = null;
        setPhase("idle");
        setError(String(e));
      }
    }
  };
  if (fullyDisabled) return null;
  const label = phase === "recording" ? t("voice.stop") : phase === "preparing" ? t("voice.preparing") : phase === "transcribing" ? t("ptt.transcribing") : t("voice.start");
  return <div className="relative inline-flex items-center gap-1">
    <button type="button" data-testid={testId} data-state={phase} aria-label={label} title={label}
      aria-pressed={phase === "recording"} disabled={disabled || phase === "preparing" || phase === "transcribing"}
      className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center shrink-0"
      onClick={() => phase === "recording" && session.current ? void finish(session.current) : void start()}>
      {phase === "recording" ? <Square className="h-4 w-4 text-red-400" /> : phase === "idle" ? <Mic className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
    </button>
    {phase !== "idle" && <button type="button" title={t("voice.cancel")} aria-label={t("voice.cancel")} data-testid={`${testId}-cancel`} onClick={cancel}><X className="h-4 w-4" /></button>}
    {error && createPortal(<div role="alert" className="fixed top-14 right-4 z-[10001] w-80 rounded border bg-[var(--taomni-panel-bg)] p-3 text-xs text-red-400">
      {error}<button type="button" className="ml-2 underline" onClick={() => { setError(""); setSetup(true); }}>{t("voice.settings")}</button>
      <button type="button" aria-label={t("voice.close")} onClick={() => setError("")}><X className="h-4 w-4" /></button>
    </div>, document.body)}
    {setup && createPortal(<div data-taomni-context-menu="" role="dialog" aria-modal="true" aria-label={t("voice.settings")} className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40" onClick={(e) => e.stopPropagation()}>
      <div className="max-h-[85vh] w-[480px] max-w-[95vw] overflow-auto rounded-lg bg-[var(--taomni-panel-bg)] p-4 shadow-xl">
        <button type="button" className="float-right taomni-btn" data-testid="voice-settings-close" aria-label={t("voice.close")} onClick={() => setSetup(false)}><X className="h-4 w-4" /></button>
        <AsrPanel />
      </div>
    </div>, document.body)}
  </div>;
}
