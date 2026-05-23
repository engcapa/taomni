import { useEffect } from "react";
import { useAiStore } from "../../stores/aiStore";

const ASR_ENGINE_LABELS: Record<string, string> = {
  "sherpa-onnx": "sherpa-onnx (推荐)",
  "whisper-rs":  "Whisper (备用)",
  "vosk":        "Vosk (低端机)",
};

const ASR_MODEL_LABELS: Record<string, string> = {
  "streaming-zipformer-bilingual-zh-en-small": "Zipformer zh-en small (~80 MB) ⭐",
  "sense-voice-small":                         "SenseVoice Small (~234 MB) 中文精准",
  "ggml-base-q5_1":                            "Whisper Base Q5 (~150 MB)",
  "vosk-model-small-cn-0.22":                  "Vosk Small CN (~42 MB)",
};

export function AsrPanel() {
  const { config, loading, loadConfig } = useAiStore();

  useEffect(() => {
    if (!config) loadConfig();
  }, []);

  if (loading || !config) {
    return <div className="text-[12px] text-[var(--moba-text-muted)]">加载中...</div>;
  }

  const asr = config.asr;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold">ASR 语音识别</div>
        <div className="text-[11px] text-[var(--moba-text-muted)]">
          音频永不出端 · 必须本地运行
        </div>
      </div>

      <div className="rounded border border-[var(--moba-divider)] bg-[var(--moba-bg)] p-3 space-y-2">
        <div>
          <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">当前引擎</label>
          <div className="text-[12px] font-medium">
            {ASR_ENGINE_LABELS[config.asr.providers[asr.active]?.engine ?? ""] ?? asr.active}
          </div>
        </div>

        <div>
          <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">当前模型</label>
          <div className="text-[12px]">
            {ASR_MODEL_LABELS[config.asr.providers[asr.active]?.model ?? ""] ?? config.asr.providers[asr.active]?.model ?? "未配置"}
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <div
            className={`w-2 h-2 rounded-full ${asr.warm_on_startup ? "bg-green-400" : "bg-gray-500"}`}
          />
          <span className="text-[11px] text-[var(--moba-text-muted)]">
            {asr.warm_on_startup ? "启动时预热 (推荐)" : "按需加载"}
          </span>
        </div>
      </div>

      <div className="rounded border border-[var(--moba-divider)] border-dashed p-3">
        <div className="text-[12px] text-[var(--moba-text-muted)] text-center">
          模型库管理 · 下载 / 切换 ASR 模型
          <br />
          <span className="text-[11px]">（即将推出 — v2.0 完整版）</span>
        </div>
      </div>
    </div>
  );
}
