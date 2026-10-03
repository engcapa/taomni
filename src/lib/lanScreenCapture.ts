// lanScreenCapture.ts — webview screenshot fallback for LanChat (task 02
// follow-up). When native capture (the Rust `screen-capture` build feature,
// backed by xcap) is unavailable — e.g. on macOS, or any default build that
// omits the feature — we grab a single frame from getDisplayMedia, paint it to
// a canvas, and hand the PNG bytes to the backend.
//
// Note: getDisplayMedia shows the OS/browser screen-picker, and macOS WKWebView
// support is limited; the call rejects there and the caller swallows it.

/** Wait for the video element to have a painted frame to draw. */
function waitForFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve) => {
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      v.requestVideoFrameCallback(() => resolve());
    } else {
      setTimeout(resolve, 120);
    }
  });
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Capture one screen frame and return it as base64-encoded PNG (no data: URI
 *  prefix). Throws if the user cancels the picker or capture is unsupported. */
export async function captureScreenPng(): Promise<string> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("no video track");

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await waitForFrame(video);

    const settings = track.getSettings();
    const w = video.videoWidth || settings.width || 1280;
    const h = video.videoHeight || settings.height || 720;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(video, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) throw new Error("encode failed");
    const buf = new Uint8Array(await blob.arrayBuffer());
    return bytesToB64(buf);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
