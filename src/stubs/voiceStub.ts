/** Browser-only opt-in fixture. Never represents actual microphone/Whisper support. */
const enabled = () => new URLSearchParams(window.location.search).get("voiceFixture") === "1";
const models = [
  { id: "whisper-base", filename: "ggml-base.bin", bytes: 147951465 },
  { id: "whisper-small", filename: "ggml-small.bin", bytes: 487601967 },
  { id: "whisper-medium", filename: "ggml-medium.bin", bytes: 1533763059 },
];
let session: string | null = null;
export async function voiceStub(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (command === "voice_capture_supported") return enabled();
  if (command === "voice_models" || command === "voice_check_models") return models.map((m) => {
    const installed = enabled() && sessionStorage.getItem(`voice-fixture:${m.id}`) === "installed";
    const update = m.id === "whisper-base" && new URLSearchParams(window.location.search).get("voiceOldBase") === "1" && !installed;
    return { ...m, license: "MIT", installed, available_version: "fixture-v2",
      installed_version: installed ? "fixture-v2" : update ? "fixture-v1" : null,
      update_available: update, integrity: installed ? command === "voice_check_models" ? "verified" : "unverified" : "missing" };
  });
  if (!enabled()) throw new Error("Voice is unavailable in browser preview. Use the desktop app.");
  if (command === "voice_install_model") {
    if (!models.some((m) => m.id === args?.modelId)) throw new Error("Unknown model");
    sessionStorage.setItem(`voice-fixture:${args?.modelId}`, "installed");
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
