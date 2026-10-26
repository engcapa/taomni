import { afterEach, expect, it, vi } from "vitest";
import { remoteBackupStub } from "./remoteBackupStub";

afterEach(() => { localStorage.clear(); vi.useRealTimers(); });

it("restores a persisted cancellation while delayed cleanup finishes independently of a view", async () => {
  vi.useFakeTimers();
  const config = await remoteBackupStub("backup_remote_get_config");
  const job = { id: "active", targetId: "local", revision: 1, operation: "local", phase: "snapshotting", bytes: 10, total: null, error: null, artifact: null, remote: null, createdAt: Date.now() };
  localStorage.setItem("taomni.qa.backup.v1", JSON.stringify({ config, jobs: [job], sessions: [], files: [] }));
  localStorage.setItem("taomni.qa.backup.cancelDelayMs", "1000");
  await remoteBackupStub("backup_remote_cancel", { jobId: "active" });
  expect(await remoteBackupStub("backup_remote_jobs")).toMatchObject([{ phase: "cancelling", cancelRequested: true }]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await remoteBackupStub("backup_remote_jobs")).toMatchObject([{ phase: "cancelled", cancelRequested: true, revision: 3 }]);
});

it("returns an observable local job for manual file exports", async () => {
  await remoteBackupStub("backup_run_manual", { request: { destination: { kind: "file", path: "/exports/chosen.taobak" }, expectedPolicyRevision: 0, expectedControlRevision: 0 } });
  expect(await remoteBackupStub("backup_remote_jobs")).toMatchObject([{ operation: "local", phase: "completed", localPath: "/exports/chosen.taobak" }]);
});
