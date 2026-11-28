import { afterEach, describe, expect, it, vi } from "vitest";
import { initialMediaAttempt, mediaSeekTarget, openMediaResource, shouldRetryAsBlob } from "../frontend/mediaResource.js";

afterEach(() => vi.unstubAllGlobals());

describe("the TaOffice media resource", () => {
  it("tries the WebView directly when available and prepares unsupported Matroska containers", () => {
    expect(initialMediaAttempt("mkv", () => "maybe")).toBe("stream");
    expect(initialMediaAttempt("mkv", () => "")).toBe("compatible");
    expect(initialMediaAttempt("mp4", () => "")).toBe("stream");
  });
  it("bounds keyboard seeks to the available duration", () => {
    expect(mediaSeekTarget(0, 12, "ArrowRight")).toBe(5);
    expect(mediaSeekTarget(11, 12, "ArrowRight")).toBe(12);
    expect(mediaSeekTarget(1, 12, "ArrowLeft")).toBe(0);
    expect(mediaSeekTarget(1, Infinity, "ArrowRight")).toBeNull();
    expect(mediaSeekTarget(1, 12, "ArrowDown")).toBeNull();
  });

  it("uses the host stream lease and retries a rejected stream only once", async () => {
    const lease = { url: "http://127.0.0.1:3333/media/example", close: vi.fn() };
    const source = { openMedia: vi.fn().mockResolvedValue(lease), read: vi.fn() };
    await expect(openMediaResource(source, "audio/wav", "stream")).resolves.toBe(lease);
    expect(source.openMedia).toHaveBeenCalledOnce();
    expect(source.read).not.toHaveBeenCalled();
    expect(shouldRetryAsBlob("stream", lease.url)).toBe(true);
    expect(shouldRetryAsBlob("stream", "blob:preview")).toBe(false);
    expect(shouldRetryAsBlob("blob", "blob:document")).toBe(false);
  });

  it("uses one scoped read for the fallback and revokes the blob on close", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:sample");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const bytes = new Blob(["data"], { type: "application/octet-stream" });
    const source = { read: vi.fn().mockResolvedValue(bytes), openMedia: vi.fn() };
    const resource = await openMediaResource(source, "audio/wav", "blob");
    expect(resource.url).toBe("blob:sample");
    expect(source.read).toHaveBeenCalledOnce();
    expect(source.openMedia).not.toHaveBeenCalled();
    expect(createObjectURL.mock.calls[0][0]).toMatchObject({ type: "audio/wav", size: 4 });
    resource.close();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:sample");
  });

  it("preserves a denied or oversized read as a user-visible failure", async () => {
    const denied = new Error("too_large: Document exceeds 32 MiB");
    await expect(openMediaResource({ read: () => Promise.reject(denied) }, "audio/wav", "blob"))
      .rejects.toBe(denied);
  });
});
