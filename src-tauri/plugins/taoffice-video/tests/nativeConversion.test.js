// @vitest-environment node
import { expect, it, vi } from "vitest";
import { convertWithHost } from "../frontend/nativeConversion.js";

const blockSize = 768 * 1024;
const defaultOptions = { container: "webm", start: 0 };

it("uploads ordered, bounded chunks and assembles the complete compatibility file", async () => {
  const fixture = new Uint8Array(blockSize + 5).fill(13);
  fixture.fill(32, blockSize);
  const release = vi.fn();
  const api = {
    deferCleanup: vi.fn().mockReturnValue(release),
    invoke: vi.fn(async (command, { offset }) => {
      if (command === "media/status") return { state: "ready", size: fixture.byteLength, mime: "video/webm" };
      if (command === "media/read") return { data: Buffer.from(fixture.subarray(offset, offset + blockSize)).toString("base64") };
      return undefined;
    }),
  };
  const { signal } = new AbortController();
  const file = await convertWithHost(api, new Blob([fixture]), {
    container: "webm", start: 2.501, end: 5, width: 80,
  }, signal, vi.fn());
  const { id } = api.invoke.mock.calls[0][1];
  expect(api.deferCleanup).toHaveBeenCalledWith("media/close", { id });
  expect(api.invoke.mock.calls.map(([command]) => command)).toEqual([
    "media/begin", "media/append", "media/append", "media/convert", "media/status", "media/read", "media/read",
  ]);
  expect(api.invoke.mock.calls.slice(1, 3).map(([, { offset, data }]) => [offset, atob(data).length]))
    .toEqual([[0, blockSize], [blockSize, 5]]);
  expect(api.invoke.mock.calls[3][1].options).toEqual({ container: "webm", startMs: 2501, endMs: 5000, width: 80 });
  expect(api.invoke.mock.calls.every(([, payload, options]) => payload.id === id && options.signal === signal)).toBe(true);
  expect(file.type).toBe("video/webm");
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(fixture);
  expect(release).toHaveBeenCalledOnce();
});

it("rejects a short native transfer and releases its session", async () => {
  const release = vi.fn();
  const api = {
    deferCleanup: () => release,
    invoke: async (command) => {
      if (command === "media/status") return { state: "ready", size: 5, mime: "video/webm" };
      if (command === "media/read") return { data: btoa("four") };
      return undefined;
    },
  };
  await expect(convertWithHost(api, new Blob(["source"]), defaultOptions, new AbortController().signal, vi.fn()))
    .rejects.toThrow("transfer was incomplete");
  expect(release).toHaveBeenCalledOnce();
});

it("closes the native session on cancellation without polling or reading it further", async () => {
  const controller = new AbortController();
  let reportProgress;
  const reported = new Promise((resolve) => { reportProgress = resolve; });
  const invoke = vi.fn(async (command) => command === "media/status" ? { state: "converting", progress: 0.25 } : undefined);
  const conversion = convertWithHost({ invoke }, new Blob(["source"]), defaultOptions, controller.signal, reportProgress);
  expect(await reported).toBe(0.25);
  controller.abort();
  await expect(conversion).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "media/begin", "media/append", "media/convert", "media/status", "media/close",
  ]);
  expect(invoke.mock.calls.at(-1)[1]).toEqual({ id: invoke.mock.calls[0][1].id });
});
