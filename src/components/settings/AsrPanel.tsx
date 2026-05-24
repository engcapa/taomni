import { useEffect } from "react";
import { useAiStore } from "../../stores/aiStore";

const ASR_ENGINE_LABELS: Record<string, string> = {
  "sherpa-onnx": "sherpa-onnx (Recommended)",
  "whisper-rs":  "Whisper (Backup)",
  "vosk":        "Vosk (Low-end devices)",
};

const ASR_MODEL_LABELS: Record<string, string> = {
  "streaming-zipformer-bilingual-zh-en-small": "Zipformer zh-en small (~80 MB) ⭐",
  "sense-voice-small":                         "SenseVoice Small (~234 MB) — strong Chinese",
  "ggml-base-q5_1":                            "Whisper Base Q5 (~150 MB)",
  "vosk-model-small-cn-0.22":                  "Vosk Small CN (~42 MB)",
};

export function AsrPanel() {
  const { config, loading, loadConfig } = useAiStore();

  useEffect(() => {
    if (!config) loadConfig();
  }, []);

  if (loading || !config) {
    return <div className="text-[12px] text-[var(--moba-text-muted)]">Loading...</div>;
  }

  const asr = config.asr;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold">ASR Speech Recognition</div>
        <div className="text-[11px] text-[var(--moba-text-muted)]">
          Audio never leaves the device · Must run locally
        </div>
      </div>

      <div className="rounded border border-[var(--moba-divider)] bg-[var(--moba-bg)] p-3 space-y-2">
        <div>
          <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">Active engine</label>
          <div className="text-[12px] font-medium">
            {ASR_ENGINE_LABELS[config.asr.providers[asr.active]?.engine ?? ""] ?? asr.active}
          </div>
        </div>

        <div>
          <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">Active model</label>
          <div className="text-[12px]">
            {ASR_MODEL_LABELS[config.asr.providers[asr.active]?.model ?? ""] ?? config.asr.providers[asr.active]?.model ?? "Not configured"}
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <div
            className={`w-2 h-2 rounded-full ${asr.warm_on_startup ? "bg-green-400" : "bg-gray-500"}`}
          />
          <span className="text-[11px] text-[var(--moba-text-muted)]">
            {asr.warm_on_startup ? "Warm up at startup (recommended)" : "Load on demand"}
          </span>
        </div>
      </div>

      <div className="rounded border border-[var(--moba-divider)] border-dashed p-3">
        <div className="text-[12px] text-[var(--moba-text-muted)] text-center">
          Model library management · download / switch ASR models
          <br />
          <span className="text-[11px]">(Coming soon — full v2.0 release)</span>
        </div>
      </div>
    </div>
  );
}
