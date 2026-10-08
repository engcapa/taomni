import { emit } from "./tauri-event";
/** Browser-only opt-in fixture. Never represents actual microphone/Whisper support. */
const enabled = () => new URLSearchParams(window.location.search).get("voiceFixture") === "1";
const models = [
  { id: "sensevoice-small", filename: "model.int8.onnx", bytes: 239233841 },
  { id: "whisper-small-q8", filename: "ggml-small-q8_0.bin", bytes: 264464607 },
  { id: "whisper-base-q8", filename: "ggml-base-q8_0.bin", bytes: 81768585 },
  { id: "whisper-medium-q8", filename: "ggml-medium-q8_0.bin", bytes: 823369779 },
  { id: "whisper-turbo-q5", filename: "ggml-large-v3-turbo-q5_0.bin", bytes: 574041195 },
  { id: "whisper-base", filename: "ggml-base.bin", bytes: 147951465 },
  { id: "whisper-small", filename: "ggml-small.bin", bytes: 487601967 },
  { id: "whisper-medium", filename: "ggml-medium.bin", bytes: 1533763059 },
];
const sherpaModel = { id: "sherpa-zipformer-zh-en", filename: "encoder-epoch-99-avg-1.int8.onnx", bytes: 199056205 };
const sherpaUrl = "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/tree/98590b7ed6443e77b714204da2757d75e1a642f4";
let session: string | null = null;
let revision = 0;
type FixtureInstallation = { revision: number; job_id: string; model_id: string; bytes: number; total: number; phase: string; error: null };
let installation: FixtureInstallation | null = null;
let sherpaInstallation: FixtureInstallation | null = null;
let cancelDownload: (() => void) | null = null;
export async function voiceStub(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (command === "voice_sherpa_model_installation") return sherpaInstallation;
  if (command === "voice_sherpa_model_status") {
    const installed = enabled() && sessionStorage.getItem(`voice-fixture:${sherpaModel.id}`) === "installed";
    const downloaded = Number(sessionStorage.getItem(`voice-partial:${sherpaModel.id}`) || 0);
    return { model_id: sherpaModel.id, revision: "fixture-v2", download_url: sherpaUrl,
      available_version: "fixture-v2", installed_version: installed ? "fixture-v2" : null,
      update_available: false, integrity: installed ? "verified" : "missing", installed,
      total_bytes: sherpaModel.bytes, downloaded_bytes: installed ? sherpaModel.bytes : downloaded,
      files: [{ filename: sherpaModel.filename, bytes: sherpaModel.bytes, downloaded, installed }],
    };
  }
  if (command === "voice_cancel_sherpa_model_installation") {
    if (sherpaInstallation?.job_id === args?.jobId) cancelDownload?.();
    return null;
  }
  if (command === "voice_model_installation") return installation;
  if (command === "voice_cancel_model_installation") {
    if (installation?.job_id === args?.jobId) cancelDownload?.();
    return null;
  }
  if (command === "voice_capture_supported") return enabled();
  if (command === "voice_models" || command === "voice_check_models") return models.map((m) => {
    const installed = enabled() && sessionStorage.getItem(`voice-fixture:${m.id}`) === "installed";
    const update = m.id === "whisper-base" && new URLSearchParams(window.location.search).get("voiceOldBase") === "1" && !installed;
    return { ...m, replacement: ({ "whisper-base": "whisper-base-q8", "whisper-small": "whisper-small-q8", "whisper-medium": "whisper-medium-q8" } as Record<string, string>)[m.id],
      download_url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/${m.filename}?download=true`,
      resumable_bytes: Number(sessionStorage.getItem(`voice-partial:${m.id}`) || 0), license: m.id === "sensevoice-small" ? "FunASR Model License v1.1" : "MIT", installed, available_version: "fixture-v2",
      installed_version: installed ? "fixture-v2" : update ? "fixture-v1" : null,
      update_available: update, integrity: installed ? command === "voice_check_models" ? "verified" : "unverified" : "missing" };
  });
  if (!enabled()) throw new Error("Voice is unavailable in browser preview. Use the desktop app.");
  if (command === "voice_install_model" || command === "voice_install_sherpa_model") {
    const streaming = command === "voice_install_sherpa_model";
    const model = streaming ? sherpaModel : models.find((m) => m.id === args?.modelId);
    if (!model) throw new Error("Unknown model");
    if (cancelDownload) throw new Error("A model installation is already running");
    const jobId = crypto.randomUUID();
    let bytes = args?.sourcePath ? 0 : Number(sessionStorage.getItem(`voice-partial:${model.id}`) || 0);
    const report = async (phase: string) => {
      const job = { revision: ++revision, job_id: jobId, model_id: model.id, bytes, total: model.bytes, phase, error: null };
      if (streaming) sherpaInstallation = job;
      else installation = job;
      await emit(streaming ? "voice-sherpa-model-progress" : "voice-model-progress", job);
    };
    await report("downloading");
    if (new URLSearchParams(window.location.search).get("voiceDownloadSlow") === "1") {
      await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          bytes = Math.min(model.bytes, bytes + Math.ceil(model.bytes / 10));
          sessionStorage.setItem(`voice-partial:${model.id}`, String(bytes));
          void report("downloading");
          if (bytes === model.bytes) { clearInterval(timer); cancelDownload = null; resolve(); }
        }, 1000);
        cancelDownload = () => {
          clearInterval(timer); cancelDownload = null;
          void report("cancelled"); reject("CANCELLED");
        };
      });
    }
    bytes = model.bytes;
    await report("verifying");
    sessionStorage.setItem(`voice-fixture:${model.id}`, "installed");
    sessionStorage.removeItem(`voice-partial:${model.id}`);
    if (args?.replaceModelId) {
      sessionStorage.removeItem(`voice-fixture:${args.replaceModelId}`);
      const saved = JSON.parse(localStorage.getItem("taomni.ai.config.v1") || "{}");
      if (saved.asr?.active === args.replaceModelId) { saved.asr.active = model.id; localStorage.setItem("taomni.ai.config.v1", JSON.stringify(saved)); }
    }
    await report("complete");
    return null;
  }
  if (command === "voice_start_capture" || command === "voice_start_stream") {
    if (session) throw new Error("Voice input is busy");
    session = String(args?.sessionId);
    if (command === "voice_start_stream") await emit("voice-transcript", { session_id: session, text: "Provisional fixture", final_text: false });
    return null;
  }
  if (command === "voice_stop_capture") {
    if (session === args?.sessionId) session = null;
    return null;
  }
  if (command === "voice_stop_stream") {
    const id = session;
    if (!id || id !== args?.sessionId) throw new Error("Recording expired");
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (session === id) {
      await emit("voice-transcript", { session_id: id, text: "Final stream fixture.", final_text: true });
      session = null;
    }
    return null;
  }
  if (command === "voice_stop_and_transcribe") {
    if (!session || session !== args?.sessionId) throw new Error("Recording expired");
    session = null;
    return { transcript: "本地语音测试 Local voice fixture.", audio_duration_ms: 1000, processing_ms: 10 };
  }
  throw new Error(`Unknown voice fixture command: ${command}`);
}
