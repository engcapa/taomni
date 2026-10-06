import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), recognize: vi.fn(), terminate: vi.fn() }));
vi.mock("tesseract.js", () => ({ createWorker: mocks.create }));
import { recognizeOffline } from "./screenshotOcr";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockResolvedValue({ recognize: mocks.recognize, terminate: mocks.terminate });
  mocks.recognize.mockResolvedValue({ data: { text: "中文 English", tsv: "level\t..." } });
  mocks.terminate.mockResolvedValue(undefined);
});
describe("bundled offline OCR", () => {
  it("loads both languages exclusively from same-origin assets and always terminates", async () => {
    expect(await recognizeOffline("data:image/png;base64,test")).toEqual({ text: "中文 English", tsv: "level\t...", langs: "bundled:eng+chi_sim" });
    const [languages, mode, options] = mocks.create.mock.calls[0];
    expect(languages).toEqual(["eng", "chi_sim"]); expect(mode).toBe(1);
    for (const field of ["workerPath", "corePath", "langPath"]) expect(new URL(options[field]).origin).toBe(new URL(document.baseURI).origin);
    expect(options.cacheMethod).toBe("none");
    expect(mocks.recognize).toHaveBeenCalledWith("data:image/png;base64,test", {}, { text: true, tsv: true });
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
  it("terminates when recognition fails", async () => {
    mocks.recognize.mockRejectedValue(new Error("bad PNG"));
    await expect(recognizeOffline("bad")).rejects.toThrow("bad PNG");
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
  it("times out a hung initialization and terminates a late worker", async () => {
    vi.useFakeTimers();
    let resolve!: (worker: unknown) => void;
    mocks.create.mockReturnValue(new Promise((r) => { resolve = r; }));
    const result = expect(recognizeOffline("test")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(90_001); await result;
    resolve({ recognize: mocks.recognize, terminate: mocks.terminate });
    await Promise.resolve(); await Promise.resolve();
    expect(mocks.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
