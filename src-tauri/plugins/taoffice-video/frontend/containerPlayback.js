import {
  BlobSource, BufferTarget, Conversion, Input, MATROSKA, Mp4OutputFormat, Output, WebMOutputFormat,
} from "mediabunny";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const containers = [
  { container: "mp4", format: Mp4OutputFormat, video: ["avc", "avc1.42001e"], audio: ["aac", "mp4a.40.2"] },
  { container: "webm", format: WebMOutputFormat, video: ["vp8", "vp8"], audio: ["opus", "opus"] },
];

const withCodecs = (mime, codecs) => mime + '; codecs="' + codecs.join(",") + '"';

export async function compatibleMedia(file, canPlay, signal, onProgress) {
  const input = new Input({ formats: [MATROSKA], source: new BlobSource(file) });
  let conversion;
  const cancel = () => { void conversion?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const tracks = [video, audio].filter(Boolean);
    if (!tracks.length) throw new Error("This file contains no playable media tracks.");
    const codecs = await Promise.all(tracks.map((track) => track.getCodecParameterString()));
    // Include codec preroll such as the first Opus packet before the video timeline starts.
    const start = Math.min(0, ...await Promise.all(tracks.map((track) => track.getFirstTimestamp())));
    const candidates = containers.map((entry) => ({ ...entry, mime: (video ? "video/" : "audio/") + entry.container }));
    const wrapped = candidates.filter(({ mime }) => codecs.every(Boolean) && canPlay(withCodecs(mime, codecs)))
      .map((entry) => ({ ...entry, playback: { copy: { mode: "forced" } } }));
    const transcoded = candidates.filter((entry) => canPlay(withCodecs(entry.mime,
      [video && entry.video[1], audio && entry.audio[1]].filter(Boolean))))
      .map((entry) => ({ ...entry, playback: {
        video: { codec: entry.video[0] },
        audio: { codec: entry.audio[0] },
      } }));
    let reason;
    for (const { mime, format, playback } of [...wrapped, ...transcoded]) {
      signal.throwIfAborted();
      const target = new BufferTarget();
      const output = new Output({ format: new format(), target });
      conversion = await Conversion.init({ input, output, tracks: "primary", trim: { start }, showWarnings: false, ...playback });
      signal.throwIfAborted();
      if (!conversion.isValid || !tracks.every((track) => conversion.utilizedTracks.includes(track))) continue;
      let full = false;
      target.on("write", ({ end }) => {
        if (end > MAX_OUTPUT_BYTES && !full) {
          full = true;
          cancel();
        }
      });
      conversion.onProgress = onProgress;
      try {
        await conversion.execute();
        if (full) throw new Error("The prepared media exceeds 32 MiB.");
        signal.throwIfAborted();
        if (!target.buffer?.byteLength) throw new Error("The compatible media is empty.");
        return new Blob([target.buffer], { type: mime });
      } catch (error) {
        signal.throwIfAborted();
        reason = full ? new Error("The prepared media exceeds 32 MiB.") : error;
      } finally {
        await conversion.cancel().catch(() => {});
      }
    }
    throw reason ?? new Error("No compatible playback format is available for these tracks.");
  } finally {
    signal.removeEventListener("abort", cancel);
    input.dispose();
  }
}
