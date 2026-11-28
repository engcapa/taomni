// @vitest-environment node
import { readFile } from "node:fs/promises";
import { BlobSource, Input, WEBM } from "mediabunny";
import { describe, expect, it } from "vitest";
import { compatibleMedia } from "../frontend/containerPlayback.js";

const file = new URL("../../../../qa-ui-auto-tests/fixtures/taoffice/rollout-compatible.mkv", import.meta.url);
const webmAvailable = (type) => /^video\/webm; codecs="vp(?:0)?8[^,]*,opus"$/.test(type);

describe("compatible Matroska playback", () => {
  it("preserves both VP8 and Opus tracks in a browser-playable WebM", async () => {
    const original = new Blob([await readFile(file)]);
    const progress = [];
    const output = await compatibleMedia(original, webmAvailable, new AbortController().signal,
      (value) => progress.push(value));
    expect(output.type).toBe("video/webm");
    const input = new Input({ formats: [WEBM], source: new BlobSource(output) });
    try {
      const video = await input.getPrimaryVideoTrack();
      const audio = await input.getPrimaryAudioTrack();
      expect(await video.getCodec()).toBe("vp8");
      expect(await audio.getCodec()).toBe("opus");
      expect(await video.getDisplayWidth()).toBe(160);
      expect(await video.getDisplayHeight()).toBe(90);
      expect(await input.computeDuration()).toBeCloseTo(12, 1);
      expect(progress.at(-1)).toBe(1);
    } finally {
      input.dispose();
    }
  });

  it("reports unsupported codecs and preserves cancellation", async () => {
    const original = new Blob([await readFile(file)]);
    await expect(compatibleMedia(original, () => false, new AbortController().signal))
      .rejects.toThrow("No compatible playback format");
    const job = new AbortController();
    job.abort();
    await expect(compatibleMedia(original, webmAvailable, job.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
