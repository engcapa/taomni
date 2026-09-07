import { afterEach, describe, expect, it } from "vitest";
import {
  invokeWithPerformanceObservation,
  summarizePerformanceSamples,
  type PerformanceIpcEvent,
} from "./performanceInstrumentation";

afterEach(() => {
  delete (globalThis as typeof globalThis & {
    __TAOMNI_PERF_OBSERVER__?: (event: PerformanceIpcEvent) => void;
  }).__TAOMNI_PERF_OBSERVER__;
});

describe("performanceInstrumentation", () => {
  it("uses nearest-rank percentiles and retains raw sample order", () => {
    expect(summarizePerformanceSamples([9, 1, 7, 3, 5])).toEqual({
      rawSamplesMs: [9, 1, 7, 3, 5],
      p50Ms: 5,
      p95Ms: 9,
      p99Ms: 9,
      maxMs: 9,
    });
    expect(() => summarizePerformanceSamples([])).toThrow(RangeError);
  });

  it("records real operation start and completion without changing its result", async () => {
    const events: PerformanceIpcEvent[] = [];
    (globalThis as typeof globalThis & {
      __TAOMNI_PERF_OBSERVER__?: (event: PerformanceIpcEvent) => void;
    }).__TAOMNI_PERF_OBSERVER__ = (event) => events.push(event);

    await expect(invokeWithPerformanceObservation(
      "workspace_read_file",
      { path: "src/main.ts" },
      async () => "contents",
    )).resolves.toBe("contents");

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: "start", command: "workspace_read_file" });
    expect(events[1]).toMatchObject({ phase: "end", command: "workspace_read_file", ok: true });
    expect(events[1].atMs).toBeGreaterThanOrEqual(events[0].atMs);
  });

  it("keeps observer failures and operation failures visible without swallowing either", async () => {
    (globalThis as typeof globalThis & {
      __TAOMNI_PERF_OBSERVER__?: () => void;
    }).__TAOMNI_PERF_OBSERVER__ = () => {
      throw new Error("observer failed");
    };

    await expect(invokeWithPerformanceObservation(
      "git_blob_pair",
      { path: "src/main.ts", oldRef: "HEAD", newRef: "" },
      async () => {
        throw new Error("provider failed");
      },
    )).rejects.toThrow("provider failed");
  });
});
