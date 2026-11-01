import { revokeScreenshotUrl } from "../../../lib/screenshot";
import { resolveOverlayPayload, type OverlayPayload } from "./prefetch";

/**
 * One mount owns one initial image load, including StrictMode's effect replay.
 * Releasing the last lease defers disposal one microtask: a synchronous effect
 * replay reacquires the same load, but an actual unmount releases even a late
 * IPC/decode result. Only this owner revokes the initial URL.
 */
export function createOverlayPayloadOwner() {
  let promise: Promise<OverlayPayload> | null = null;
  let consumers = 0;
  let revision = 0;
  let disposed = false;

  return {
    acquire() {
      if (disposed) throw new Error("screenshot image owner already disposed");
      consumers += 1;
      revision += 1;
      const loading = promise ??= resolveOverlayPayload();
      let released = false;
      return {
        promise: loading,
        release() {
          if (released) return;
          released = true;
          consumers -= 1;
          const releaseRevision = ++revision;
          queueMicrotask(() => {
            if (consumers || revision !== releaseRevision || disposed) return;
            disposed = true;
            void loading.then(({ url }) => revokeScreenshotUrl(url), () => undefined);
          });
        },
      };
    },
  };
}
