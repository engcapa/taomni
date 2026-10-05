import { describe, expect, it, vi } from "vitest";
import { CloseCoordinator, type CloseAdapter, type CloseTarget } from "./closeCoordinator";
import { ResourceLeases } from "./panelRegistry";

function target(id: string, adapter?: Partial<CloseAdapter>): CloseTarget {
  return { id, title: id, adapter: { getRisks: async () => [], resolve: async () => undefined, flush: async () => undefined, ...adapter }, commit: vi.fn() };
}
describe("Close transactions", () => {
  it("flushes clean exit targets once without repeating the app exit confirmation", async () => {
    const order: string[] = [];
    const targets = ["workspace", "git", "problems", "terminal"].map((id) => ({
      ...target(id, { flush: async () => { order.push(`flush:${id}`); } }),
      commit: () => { order.push(`close:${id}`); },
    }));
    const prompt = vi.fn(async () => null);
    const result = await new CloseCoordinator(prompt).request(targets, true);
    expect(result).toEqual({ status: "closed", closed: targets.map((item) => item.id), failed: [] });
    expect(prompt).not.toHaveBeenCalled();
    expect(order).toEqual(targets.flatMap((item) => [`flush:${item.id}`, `close:${item.id}`]));
  });

  it("still confirms a clean bulk tab close and preserves every target on cancel", async () => {
    const targets = [target("workspace"), target("terminal")];
    const prompt = vi.fn(async () => null);
    const result = await new CloseCoordinator(prompt).request(targets);
    expect(result.status).toBe("cancelled");
    expect(prompt).toHaveBeenCalledTimes(1);
    targets.forEach((item) => expect(item.commit).not.toHaveBeenCalled());
  });

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
  it("reports exact closed/remaining identities and retries without repeating committed saves", async () => {
    let fail = true;
    const a = target("a"), b = target("b", { flush: async () => { if (fail) throw new Error("disk full"); } }), c = target("c");
    const prompt = vi.fn<import("./closeCoordinator").ClosePrompt>(async (_items, _errors, progress): ReturnType<import("./closeCoordinator").ClosePrompt> => {
      if (progress) {
        expect(progress).toEqual({ closed: [{ id: "a", title: "a" }], remaining: [{ id: "b", title: "b" }, { id: "c", title: "c" }] });
        fail = false; return { "$remaining": "retry" as const };
      }
      return {};
    });
    expect(await new CloseCoordinator(prompt).request([a, b, c])).toMatchObject({ status: "closed", closed: ["a", "b", "c"], failed: [] });
    [a, b, c].forEach((item) => expect(item.commit).toHaveBeenCalledOnce());
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
