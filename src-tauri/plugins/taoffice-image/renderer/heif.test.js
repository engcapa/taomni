import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeHeif } from "./heif.js";

const bytes = new Uint8Array([10, 20, 30, 40]);
const wasm = new Uint8Array([0, 97, 115, 109]).buffer;
const png = new Uint8Array([137, 80, 78, 71]).buffer;
const URLClass = URL;
const createUrl = vi.fn(() => "blob:heif-worker");
const revokeUrl = vi.fn();
let fetchWasm;
let workers;

beforeEach(() => {
  workers = [];
  fetchWasm = vi.fn(async () => ({ ok: true, arrayBuffer: async () => wasm }));
  vi.stubGlobal("fetch", fetchWasm);
  vi.stubGlobal("Worker", class {
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() { workers.push(this); }
  });
  vi.stubGlobal("URL", class extends URLClass {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  });
  createUrl.mockClear();
  revokeUrl.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function startWorker(signal) {
  const promise = decodeHeif(bytes.subarray(1, 3), signal);
  await vi.waitFor(() => expect(workers[0]?.postMessage).toHaveBeenCalledOnce());
  return { promise, worker: workers[0] };
}

describe("HEIF Worker lifecycle", () => {
  it("returns a PNG Blob and transfers a private copy of just the selected bytes", async () => {
    const { promise, worker } = await startWorker();
    const [{ input, wasm: decoderBytes }, transfers] = worker.postMessage.mock.lastCall;
    expect(new Uint8Array(input)).toEqual(new Uint8Array([20, 30]));
    expect(input).not.toBe(bytes.buffer);
    expect(transfers).toEqual([input, decoderBytes]);
    worker.onmessage({ data: { png, width: 160, height: 96 } });
    const { blob, width, height } = await promise;
    expect({ width, height, mime: blob.type, size: blob.size }).toEqual({ width: 160, height: 96, mime: "image/png", size: 4 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledWith("blob:heif-worker");
  });

  it("terminates the worker on cancellation and ignores a late result", async () => {
    const controller = new AbortController();
    const { promise, worker } = await startWorker(controller.signal);
    const error = new DOMException("Viewer closed", "AbortError");
    controller.abort(error);
    worker.onmessage({ data: { png, width: 160, height: 96 } });
    await expect(promise).rejects.toBe(error);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledOnce();
  });

  it("limits the decoding time, releases the worker, and supports a following request", async () => {
    vi.useFakeTimers();
    const { promise, worker } = await startWorker();
    const result = expect(promise).rejects.toThrow("limits");
    await vi.advanceTimersByTimeAsync(25_000);
    await result;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledOnce();
    const next = decodeHeif(bytes);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    workers[1].onmessage({ data: { png, width: 32, height: 48 } });
    await expect(next).resolves.toMatchObject({ width: 32, height: 48 });
  });

  it("returns a decoder error when the worker sends invalid output", async () => {
    const { promise, worker } = await startWorker();
    worker.onmessage({ data: { png, width: 0, height: 1 } });
    await expect(promise).rejects.toThrow("engine");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledOnce();
  });

  it("rejects empty input, oversized input and prior cancellation before fetching the decoder", async () => {
    await expect(decodeHeif(bytes.subarray(0, 0))).rejects.toThrow("format");
    await expect(decodeHeif(new Uint8Array(32 * 1024 * 1024 + 1))).rejects.toThrow("limits");
    const reason = new DOMException("Viewer closed", "AbortError");
    await expect(decodeHeif(bytes, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(fetchWasm).not.toHaveBeenCalled();
  });
});
