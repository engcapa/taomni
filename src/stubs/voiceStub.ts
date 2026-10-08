import { emit } from "./tauri-event";
/** Browser-only opt-in fixture. Never represents actual microphone/Whisper support. */
const enabled = () => new URLSearchParams(window.location.search).get("voiceFixture") === "1";
const models = [
  { id: "whisper-base", filename: "ggml-base.bin", bytes: 147951465 },
  { id: "whisper-small", filename: "ggml-small.bin", bytes: 487601967 },
  { id: "whisper-medium", filename: "ggml-medium.bin", bytes: 1533763059 },
];
let session: string | null = null;
let revision = 0;
let installation: { revision: number; job_id: string; model_id: string; bytes: number; total: number; phase: string; error: null } | null = null;
let cancelDownload: (() => void) | null = null;
export async function voiceStub(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (command === "voice_model_installation") return installation;
  if (command === "voice_cancel_model_installation") {
    if (installation?.job_id === args?.jobId) cancelDownload?.();
    return null;
  }
  if (command === "voice_capture_supported") return enabled();
  if (command === "voice_models" || command === "voice_check_models") return models.map((m) => {
    const installed = enabled() && sessionStorage.getItem(`voice-fixture:${m.id}`) === "installed";
    const update = m.id === "whisper-base" && new URLSearchParams(window.location.search).get("voiceOldBase") === "1" && !installed;
    return { ...m,
      download_url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/${m.filename}?download=true`,
      resumable_bytes: Number(sessionStorage.getItem(`voice-partial:${m.id}`) || 0), license: "MIT", installed, available_version: "fixture-v2",
      installed_version: installed ? "fixture-v2" : update ? "fixture-v1" : null,
      update_available: update, integrity: installed ? command === "voice_check_models" ? "verified" : "unverified" : "missing" };
  });
  if (!enabled()) throw new Error("Voice is unavailable in browser preview. Use the desktop app.");
  if (command === "voice_install_model") {
    const model = models.find((m) => m.id === args?.modelId);
    if (!model) throw new Error("Unknown model");
    if (cancelDownload) throw new Error("A model installation is already running");
    const jobId = crypto.randomUUID();
    let bytes = args?.sourcePath ? 0 : Number(sessionStorage.getItem(`voice-partial:${model.id}`) || 0);
    const report = async (phase: string) => {
      installation = { revision: ++revision, job_id: jobId, model_id: model.id, bytes, total: model.bytes, phase, error: null };
      await emit("voice-model-progress", installation);
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
    await report("complete");
    return null;
  }
  if (command === "voice_start_capture") {
    if (session) throw new Error("Voice input is busy");
    session = String(args?.sessionId);
    return null;
  }
  if (command === "voice_stop_capture") {
    if (session === args?.sessionId) session = null;
    return null;
  }
  if (command === "voice_stop_and_transcribe") {
    if (!session || session !== args?.sessionId) throw new Error("Recording expired");
    session = null;
    return { transcript: "本地语音测试 Local voice fixture.", audio_duration_ms: 1000, processing_ms: 10 };
  }
  throw new Error(`Unknown voice fixture command: ${command}`);
}
