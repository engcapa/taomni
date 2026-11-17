import { readStreamClose, readStreamOpen, readStreamRead } from "../../../lib/ipc";
import { DRAWIO_MAX_BYTES } from "./drawioCodec";

/** Read only the explicitly selected local file, with the same byte limit as
 * browser imports. A late chooser/read must not keep a closed editor alive. */
export async function readDrawioFile(path: string, active: () => boolean): Promise<string | null> {
  const { handleId, size } = await readStreamOpen(path);
  try {
    if (!active()) return null;
    if (size > DRAWIO_MAX_BYTES) throw new Error("draw.io file exceeds the 20 MB limit");
    const decoder = new TextDecoder();
    let text = "", bytes = 0;
    while (active()) {
      const chunk = await readStreamRead(handleId, Math.min(64 * 1024, DRAWIO_MAX_BYTES - bytes + 1));
      if (!active()) return null;
      bytes += chunk.length;
      if (bytes > DRAWIO_MAX_BYTES) throw new Error("draw.io file exceeds the 20 MB limit");
      if (!chunk.length) return text + decoder.decode();
      text += decoder.decode(chunk, { stream: true });
    }
    return null;
  } finally {
    await readStreamClose(handleId);
  }
}
