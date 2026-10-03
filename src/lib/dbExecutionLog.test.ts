import { describe, expect, it } from "vitest";
import {
  MAX_EXECUTION_LOG_RUNS,
  createExecutionRun,
  finishExecutionRun,
  patchExecutionEntry,
  prependExecutionRun,
  summarizeExecutionRun,
} from "./dbExecutionLog";

describe("dbExecutionLog", () => {
  it("creates one not-run entry per statement with stable ordinals", () => {
    const run = createExecutionRun(["select 1", "select 2"], 1000);
    expect(run.entries.map((entry) => [entry.ordinal, entry.sql, entry.status])).toEqual([
      [1, "select 1", "not-run"],
      [2, "select 2", "not-run"],
    ]);
    expect(run.finishedAt).toBeNull();
  });

  it("summarizes statuses and total duration", () => {
    let run = createExecutionRun(["a", "b", "c"], 1000);
    const [first, second] = run.entries;
    run = patchExecutionEntry(run, first.id, { status: "success", durationMs: 12, rowCount: 3 });
    run = patchExecutionEntry(run, second.id, { status: "failed", durationMs: 5, message: "Table 'x' doesn't exist" });
    const summary = summarizeExecutionRun(finishExecutionRun(run, 2000));
    expect(summary).toMatchObject({ total: 3, success: 1, failed: 1, notRun: 1, cancelled: 0, durationMs: 17 });
  });

  it("marks an interrupted running entry as cancelled when the run finishes", () => {
    let run = createExecutionRun(["select sleep(10)", "select 2"], 1000);
    run = patchExecutionEntry(run, run.entries[0].id, { status: "running", startedAt: 1000 });
    const finished = finishExecutionRun(run, 1500);
    expect(finished.entries.map((entry) => entry.status)).toEqual(["cancelled", "not-run"]);
    expect(finished.finishedAt).toBe(1500);
  });

  it("keeps the newest runs first and drops the oldest beyond the cap", () => {
    let runs = [] as ReturnType<typeof createExecutionRun>[];
    for (let index = 0; index < MAX_EXECUTION_LOG_RUNS + 3; index += 1) {
      runs = prependExecutionRun(runs, createExecutionRun([`select ${index}`], index));
    }
    expect(runs).toHaveLength(MAX_EXECUTION_LOG_RUNS);
    expect(runs[0].entries[0].sql).toBe(`select ${MAX_EXECUTION_LOG_RUNS + 2}`);
    expect(runs.at(-1)?.entries[0].sql).toBe("select 3");
  });
});
