import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFileBytes } from "../../../lib/ipc";
import { isTauriRuntime } from "../../../lib/runtime";
import { useAiStore } from "../../../stores/aiStore";
import { DictationButton } from "../../voice/DictationButton";
import { taoText as tr } from "../i18n";
import type { TaoChatController } from "./ports";

let playing: AudioBufferSourceNode | undefined;
let player: AudioContext | undefined;
export async function stopTaoSpeech() { playing?.stop(); playing = undefined; await player?.close(); player = undefined; await invoke("deepseek_app_stop", { threadId: "tao-tts" }); }

export async function speakTao(text: string, voiceId: string) {
  await stopTaoSpeech();
  const audio: number[] = [];
  const onAudio = new Channel<number[]>();
  onAudio.onmessage = (bytes) => audio.push(...bytes);
  await invoke("deepseek_app_tts", { text, voiceId, onAudio });
  player = new AudioContext({ sampleRate: 24000 });
  const buffer = player.createBuffer(1, Math.floor(audio.length / 2), 24000);
  const floats = buffer.getChannelData(0);
  for (let index = 0; index < floats.length; index++) { const value = audio[index * 2] | (audio[index * 2 + 1] << 8); floats[index] = (value >= 32768 ? value - 65536 : value) / 32768; }
  playing = player.createBufferSource(); playing.buffer = buffer; playing.connect(player.destination); playing.start();
}

export function SpeechPanel({ controller }: { controller: TaoChatController }) {
  const config = useAiStore((state) => state.config?.deepseek_app);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owner = useRef(0);
  useEffect(() => () => { owner.current++; }, []);
  const append = (text: string) => { const draft = controller.getState().composer.text; controller.setComposerText(`${draft}${draft ? "\n" : ""}${text}`); };
  const transcribe = async () => {
    const operation = ++owner.current;
    try {
      const path = await open({ multiple: false, filters: [{ name: "Audio", extensions: ["wav", "ogg"] }] });
      if (!path || Array.isArray(path)) return;
      setBusy(true); setError("");
      const data = await readFileBytes(path);
      const audioContext = new AudioContext();
      let durationMs: number;
      try { durationMs = Math.ceil((await audioContext.decodeAudioData(Uint8Array.from(data).buffer)).duration * 1000); } finally { await audioContext.close(); }
      const text = await invoke<string>("deepseek_app_asr", { audio: Array.from(data), mime: path.toLowerCase().endsWith(".ogg") ? "audio/ogg" : "audio/wav", durationMs });
      if (owner.current === operation) append(text);
    } catch (cause) { if (owner.current === operation) setError(String(cause)); }
    finally { if (owner.current === operation) setBusy(false); }
  };
  return <section data-testid="tao-home-speech"><h3>{tr("语音")}</h3><p>{tr("本地录音仅回填草稿，不会自动发送。")}</p><DictationButton testId="tao-home-dictation" contextKey={controller.getState().activeThreadId} onTranscript={append} disabled={!isTauriRuntime()} />{config?.voice_provider === "deepseek" ? <><p>{tr("DeepSeek 语音：选择 WAV / OGG，最长 60 秒。")}</p><button type="button" data-testid="tao-home-asr-file" disabled={busy || !isTauriRuntime()} onClick={() => void transcribe()}>{tr("识别音频文件")}</button>{busy ? <button type="button" onClick={() => { owner.current++; setBusy(false); void invoke("deepseek_app_stop", { threadId: "tao-asr" }); }}>{tr("取消")}</button> : null}</> : null}<button type="button" data-testid="tao-home-tts-stop" disabled={!isTauriRuntime()} onClick={() => void stopTaoSpeech().catch((cause) => setError(String(cause)))}>{tr("停止朗读")}</button>{busy ? <p>{tr("正在识别…")}</p> : null}{error ? <p role="alert">{error}</p> : null}</section>;
}
