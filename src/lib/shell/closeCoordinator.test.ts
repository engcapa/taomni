import { describe, expect, it, vi } from "vitest";
import { CloseCoordinator, type CloseAdapter, type CloseTarget } from "./closeCoordinator";
import { ResourceLeases } from "./panelRegistry";

function target(id: string, adapter?: Partial<CloseAdapter>): CloseTarget {
  return { id, title: id, adapter: { getRisks: async () => [], resolve: async () => undefined, flush: async () => undefined, ...adapter }, commit: vi.fn() };
}
describe("Close transactions", () => {
  it("does not remove anything when preflight is cancelled", async () => {
    const a = target("a", { getRisks: async () => [{ id: "dirty", ownerId: "a", kind: "dirty", detail: "Unsaved", revision: "1", choices: ["save", "discard", "cancel"] }] });
    const b = target("b");
    const result = await new CloseCoordinator(async () => null).request([a, b]);
    expect(result.status).toBe("cancelled"); expect(a.commit).not.toHaveBeenCalled(); expect(b.commit).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent clicks and awaits flush before removal", async () => {
    let release!: () => void;
    const a = target("a", { flush: () => new Promise<void>((resolve) => { release = resolve; }) });
    const coordinator = new CloseCoordinator(async () => ({}));
    const first = coordinator.request([a]), second = coordinator.request([a, a]);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(a.commit).not.toHaveBeenCalled(); release(); await first; expect(a.commit).toHaveBeenCalledTimes(1);
  });
  it("reports partial success honestly and retains a target whose save fails", async () => {
    const a = target("a"), b = target("b", { flush: async () => { throw new Error("disk full"); } }), c = target("c");
    const result = await new CloseCoordinator(async () => ({})).request([a, b, c]);
    expect(result).toMatchObject({ status: "partial", closed: ["a"], failed: [{ id: "b", error: "Error: disk full" }] });
    expect(b.commit).not.toHaveBeenCalled();
    expect(c.commit).not.toHaveBeenCalled();
  });
  it("rechecks changed revisions and rejects background at process exit", async () => {
    let revision = "1";
    const a = target("a", { getRisks: async () => [{ id: "job", ownerId: "a", kind: "job", detail: "Transfer", revision, choices: ["background", "cancel-job", "cancel"] }] });
    const prompt = vi.fn(async () => { revision = "2"; return { job: "background" as const }; });
    expect((await new CloseCoordinator(prompt).request([a], true)).status).toBe("cancelled");
    expect(a.commit).not.toHaveBeenCalled();
    const changePrompt = vi.fn(async () => { if (changePrompt.mock.calls.length === 1) { revision = "3"; return { job: "cancel-job" as const }; } return null; });
    expect((await new CloseCoordinator(changePrompt).request([a])).status).toBe("cancelled");
    expect(changePrompt).toHaveBeenCalledTimes(2);
  });
});
describe("Transfer resource groups", () => {
  it("keeps a group alive until its last view or job releases, including repeated cleanup", () => {
    const leases = new ResourceLeases(), view = leases.acquire("files-a", "view-a", "view"), j1 = leases.acquire("files-a", "j1", "job"), j2 = leases.acquire("files-a", "j2", "job");
    view(); j1(); j1(); expect(leases.retained("files-a")).toBe(true); expect(leases.jobs("files-a")).toEqual(["j2"]);
    j2(); expect(leases.retained("files-a")).toBe(false);
  });
});
