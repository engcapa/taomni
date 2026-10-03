import { useEffect } from "react";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";

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
  const t = useT();

  useEffect(() => {
    if (!config) loadConfig();
  }, []);

  if (loading || !config) {
    return <div className="text-[12px] text-[var(--taomni-text-muted)]">{t("aiSettings.loading")}</div>;
  }

  const asr = config.asr;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold">{t("aiSettings.asrTitle")}</div>
        <div className="text-[11px] text-[var(--taomni-text-muted)]">
          {t("aiSettings.asrSubtitle")}
        </div>
      </div>

      <div className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] p-3 space-y-2">
        <div>
          <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.asrActiveEngine")}</label>
          <div className="text-[12px] font-medium">
            {ASR_ENGINE_LABELS[config.asr.providers[asr.active]?.engine ?? ""] ?? asr.active}
          </div>
        </div>

        <div>
          <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.asrActiveModel")}</label>
          <div className="text-[12px]">
            {ASR_MODEL_LABELS[config.asr.providers[asr.active]?.model ?? ""] ?? config.asr.providers[asr.active]?.model ?? t("aiSettings.asrNotConfigured")}
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <div
            className={`w-2 h-2 rounded-full ${asr.warm_on_startup ? "bg-green-400" : "bg-gray-500"}`}
          />
          <span className="text-[11px] text-[var(--taomni-text-muted)]">
            {asr.warm_on_startup ? t("aiSettings.asrWarmStart") : t("aiSettings.asrLoadOnDemand")}
          </span>
        </div>
      </div>

      <div className="rounded border border-[var(--taomni-divider)] border-dashed p-3">
        <div className="text-[12px] text-[var(--taomni-text-muted)] text-center">
          {t("aiSettings.asrModelLibrary")}
          <br />
          <span className="text-[11px]">{t("aiSettings.asrComingSoon")}</span>
        </div>
      </div>
    </div>
  );
}
