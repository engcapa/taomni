import { useCallback, useRef } from "react";
import { parseAudioFrame } from "../../../lib/rdp";

export interface UseRdpAudioContext {
  initRef: import("react").RefObject<{ host: string; port: number; username: string | null | undefined; password: string | undefined; options: import("../../../types/rdp").RdpOptions; networkSettingsJson: string | null | undefined; }>;
}

export function useRdpAudio(context: UseRdpAudioContext) {
  const { initRef } = context;
  const audioRef = useRef<{ ctx: AudioContext; nextTime: number; } | null>(null);

  const closeAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      void audio.ctx.close().catch(() => { });
    }
  }, []);

  const playAudioFrame = useCallback((frame: ReturnType<typeof parseAudioFrame>) => {
    if (!frame || initRef.current.options.redirectAudio !== "play") return;
    if (frame.channels < 1 || frame.channels > 2 || frame.bitsPerSample !== 16) return;

    const AudioContextCtor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (window as Window & { webkitAudioContext?: typeof AudioContext; }).webkitAudioContext;
    if (!AudioContextCtor) return;

    let audio = audioRef.current;
    if (!audio || audio.ctx.state === "closed") {
      audio = { ctx: new AudioContextCtor({ sampleRate: frame.sampleRate }), nextTime: 0 };
      audioRef.current = audio;
    }
    if (audio.ctx.state === "suspended") {
      void audio.ctx.resume().catch(() => { });
    }

    const bytesPerSample = frame.bitsPerSample / 8;
    const frameSize = bytesPerSample * frame.channels;
    const sampleCount = Math.floor(frame.pcm.byteLength / frameSize);
    if (sampleCount <= 0) return;

    const buffer = audio.ctx.createBuffer(frame.channels, sampleCount, frame.sampleRate);
    const view = new DataView(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength);
    for (let i = 0; i < sampleCount; i += 1) {
      for (let ch = 0; ch < frame.channels; ch += 1) {
        const offset = i * frameSize + ch * bytesPerSample;
        buffer.getChannelData(ch)[i] = view.getInt16(offset, true) / 32768;
      }
    }

    const source = audio.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.ctx.destination);
    const startAt = Math.max(audio.nextTime, audio.ctx.currentTime + 0.02);
    source.start(startAt);
    audio.nextTime = startAt + buffer.duration;
  }, []);
  return { playAudioFrame, closeAudio };
}
