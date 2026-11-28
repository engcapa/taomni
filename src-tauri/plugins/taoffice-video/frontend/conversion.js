import {
  BlobSource, BufferTarget, Conversion, Input, MATROSKA, MP4, Mp4OutputFormat,
  Output, QTFF, WEBM, WebMOutputFormat,
} from "mediabunny";

export const MAX_MEDIA_BYTES = 32 * 1024 * 1024;

export const outputFormats = {
  webm: { title: "WebM", mime: "video/webm", format: WebMOutputFormat, video: "vp8", audio: "opus",
    playback: 'video/webm; codecs="vp8,opus"' },
  mp4: { title: "MP4", mime: "video/mp4", format: Mp4OutputFormat, video: "avc", audio: "aac",
    playback: 'video/mp4; codecs="avc1.42001e,mp4a.40.2"' },
};

export function outputWidth(options, sourceWidth) {
  return options.width == null ? undefined : Math.min(sourceWidth, options.width);
}

export function validClip(start, end, duration) {
  if (start.trim() === "" || end.trim() === "") return false;
  const startTime = Number(start);
  const endTime = Number(end);
  const startMs = Math.round(startTime * 1000);
  const endMs = Math.round(endTime * 1000);
  return Number.isFinite(duration) && Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs)
    && startTime === startMs / 1000 && endTime === endMs / 1000
    && startMs >= 0 && endMs > startMs && endTime <= duration;
}

export async function convertInWebView(file, options, signal, progress) {
  if (!file.size || file.size > MAX_MEDIA_BYTES) throw new Error("Media conversion is limited to 32 MiB input.");
  const spec = outputFormats[options.container];
  // Restrict detection to local video containers. Playlist input could fetch secondary files.
  const input = new Input({ source: new BlobSource(file), formats: [MATROSKA, MP4, QTFF, WEBM] });
  let conversion;
  let full = false;
  const cancel = () => { void conversion?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new Error("This file contains no convertible video track.");
    const sourceWidth = await video.getDisplayWidth();
    const requested = outputWidth(options, sourceWidth);
    const width = requested && requested < sourceWidth ? Math.max(2, Math.floor(requested / 2) * 2) : undefined;
    const first = Math.min(0, await video.getFirstTimestamp(), audio ? await audio.getFirstTimestamp() : 0);
    const target = new BufferTarget();
    const output = new Output({ format: new spec.format(), target });
    conversion = await Conversion.init({
      input, output,
      tracks: "primary",
      showWarnings: false,
      trim: { start: options.start + first, end: (options.end ?? await input.computeDuration()) + first },
      video: { codec: spec.video, width },
      audio: { codec: spec.audio },
    });
    signal.throwIfAborted();
    if (!conversion.isValid || !conversion.utilizedTracks.includes(video)
      || (audio && !conversion.utilizedTracks.includes(audio))) {
      throw new Error("This WebView cannot convert all the media tracks to the selected format.");
    }
    target.on("write", ({ end }) => {
      if (end > MAX_MEDIA_BYTES && !full) {
        full = true;
        cancel();
      }
    });
    conversion.onProgress = progress;
    await conversion.execute();
    signal.throwIfAborted();
    const buffer = target.buffer;
    if (full) throw new Error("The converted media exceeds 32 MiB. Choose a shorter clip or smaller size.");
    if (!buffer?.byteLength) throw new Error("The conversion produced no media.");
    return new Blob([buffer], { type: spec.mime });
  } catch (error) {
    signal.throwIfAborted();
    if (full) throw new Error("The converted media exceeds 32 MiB. Choose a shorter clip or smaller size.");
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    await conversion?.cancel().catch(() => {});
    input.dispose();
  }
}
