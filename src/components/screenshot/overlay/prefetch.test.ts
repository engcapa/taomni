import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardOverlayPrefetch, resolveOverlayPayload, startOverlayPrefetch, takeOverlayPrefetch } from "./prefetch";

const api = vi.hoisted(() => ({ init: vi.fn(), load: vi.fn(), revoke: vi.fn() }));
vi.mock("../../../lib/screenshot", () => ({
  fetchOverlayInit: api.init, revokeScreenshotUrl: api.revoke,
  captureFull: vi.fn(), isScreenshotOverlayWindow: () => true,
}));
vi.mock("./images", () => ({ loadArtifact: api.load }));
vi.mock("./startupTiming", () => ({ markOverlayStartup: vi.fn() }));
const init = (generation: number) => ({ path: `capture-${generation}.png`, generation, displayId: "0,0", width: 80, height: 60, scaleFactor: 1 });
const image = { naturalWidth: 80, naturalHeight: 60 } as HTMLImageElement;

beforeEach(() => {
  vi.clearAllMocks();
  api.load.mockImplementation(async (path: string) => ({ img: image, url: `blob:${path}` }));
});
afterEach(() => { takeOverlayPrefetch(); });

describe("generation-owned early screenshot prefetch", () => {
  it("does not reuse the decoded first-open image for the next generation", async () => {
    api.init.mockResolvedValueOnce(init(7)).mockResolvedValueOnce(init(8));
    startOverlayPrefetch();
    await vi.waitFor(() => expect(api.load).toHaveBeenCalledWith("capture-7.png", expect.any(Function)));
    const payload = await resolveOverlayPayload(8);
    expect(payload.init.generation).toBe(8);
    expect(payload.url).toBe("blob:capture-8.png");
    expect(api.revoke).toHaveBeenCalledExactlyOnceWith("blob:capture-7.png");
    expect(api.init).toHaveBeenCalledTimes(2);
  });

  it("does not carry a retired prefetch read error into a new session", async () => {
    api.init.mockResolvedValueOnce(init(7)).mockResolvedValueOnce(init(8));
    api.load.mockRejectedValueOnce(new Error("retired artifact was purged"));
    startOverlayPrefetch();
    await vi.waitFor(() => expect(api.load).toHaveBeenCalled());
    expect((await resolveOverlayPayload(8)).init.generation).toBe(8);
  });

  it("releases an unconsumed image that decodes after the host becomes idle", async () => {
    let decode!: (value: { img: HTMLImageElement; url: string }) => void;
    api.init.mockResolvedValueOnce(init(7)).mockResolvedValueOnce(init(8));
    api.load.mockReturnValueOnce(new Promise((resolve) => { decode = resolve; }));
    startOverlayPrefetch();
    await vi.waitFor(() => expect(api.load).toHaveBeenCalled());
    discardOverlayPrefetch();
    decode({ img: image, url: "blob:retired-pending" });
    await vi.waitFor(() => expect(api.revoke).toHaveBeenCalledExactlyOnceWith("blob:retired-pending"));
    expect((await resolveOverlayPayload(8)).init.generation).toBe(8);
  });

  it("retains same-generation decode failures for the error-ready path", async () => {
    api.init.mockResolvedValueOnce(init(8));
    api.load.mockRejectedValueOnce(new Error("current artifact read failed"));
    startOverlayPrefetch();
    await expect(resolveOverlayPayload(8)).rejects.toMatchObject({ overlayGeneration: 8 });
    expect(api.init).toHaveBeenCalledOnce();
  });
});
