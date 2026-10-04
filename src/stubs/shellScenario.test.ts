import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellScenarioBefore } from "./shellScenario";

const faultKey = "taomni.qa.shell.fault";
function hold(once = false) {
  localStorage.setItem(faultKey, JSON.stringify({ command: "workspace_list_dir", owner: "/repo", mode: "hold", once }));
}

describe("controlled Shell backend readiness", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("taomni.qa.shell.enabled", "true");
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

  it("holds only the first matching workspace so a second same-path instance can finish first", async () => {
    hold(true);
    let firstReady = false;
    const first = shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" }).then(() => { firstReady = true; });
    await shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" });
    await vi.advanceTimersByTimeAsync(100);
    expect(firstReady).toBe(false);
    const observations = JSON.parse(localStorage.getItem("taomni.qa.shell.observations")!);
    expect(observations.filter((row: { status: string }) => row.status === "held")).toHaveLength(1);
    localStorage.removeItem(faultKey);
    await vi.advanceTimersByTimeAsync(25);
    await first;
    expect(firstReady).toBe(true);
  });

  it("does not consume a one-shot hold for a different owner or command", async () => {
    hold(true);
    await shellScenarioBefore("workspace_list_dir", { repoRoot: "/other" });
    await shellScenarioBefore("notes_list", { repoRoot: "/repo" });
    expect(JSON.parse(localStorage.getItem(faultKey)!).claimed).toBeUndefined();
    const pending = shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo/child" });
    expect(JSON.parse(localStorage.getItem(faultKey)!).claimed).toBe(true);
    localStorage.removeItem(faultKey);
    await vi.advanceTimersByTimeAsync(25);
    await pending;
  });

  it("reports the preparation deadline instead of acknowledging an unreleased hold", async () => {
    hold(true);
    const outcome = shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await outcome).toMatchObject({ message: "QA fixture held workspace_list_dir beyond preparation deadline" });
  });

  it("rejects one matching request and leaves retry and disabled fixtures working", async () => {
    localStorage.setItem(faultKey, JSON.stringify({ command: "workspace_list_dir", mode: "fail-next" }));
    await expect(shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" })).rejects.toThrow("QA fixture rejected");
    await expect(shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" })).resolves.toBeUndefined();
    hold();
    localStorage.removeItem("taomni.qa.shell.enabled");
    await expect(shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" })).resolves.toBeUndefined();
  });
});
