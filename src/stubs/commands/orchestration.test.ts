import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSettings, invokeOrchestration } from "./orchestration";
import type { AgentRun, AgentSettings, AgentSubmission } from "../../lib/ipc/orchestration";

vi.mock("../localVfs", () => ({ vfsReadText: async (path: string) => {
  if (path.endsWith("AGENTS.md")) return "Preserve existing contracts.";
  if (path.endsWith("spec.md")) return "Implement a settings field.";
  throw new Error("not found");
} }));

async function seed(model = "fixture-partial") {
  const settings: AgentSettings = { ...defaultAgentSettings(), planningResourceId: "api", reviewResourceId: "api", resources: [{
    id: "api", name: "Planning", kind: "api", protocol: "anthropic_messages", model, baseUrl: "http://127.0.0.1:1/v1",
    providerId: "", keyRef: "", harness: "claude_code", binary: "", args: [], costCoefficient: 1, proxyMode: "none",
  }] };
  return await invokeOrchestration("orchestration_save_settings", { settings, expectedRevision: 1 }) as AgentSettings;
}
function submission(revision: number): AgentSubmission {
  return { commandId: "one-command", projectPath: "/preview", goal: "Design settings", intent: "plan", sourcePaths: ["spec.md"], expectedSettingsRevision: revision };
}
async function create(revision: number) {
  return await invokeOrchestration("orchestration_create_run", { submission: submission(revision) }) as AgentRun;
}

describe("explicit browser-only orchestration projection", () => {
  beforeEach(() => localStorage.clear());

  it("does not execute on create and freezes shared defaults for subsequent edits", async () => {
    const settings = await seed();
    const first = await create(settings.revision);
    const duplicate = await create(settings.revision);
    expect(duplicate.id).toBe(first.id);
    expect(first).toMatchObject({ status: "planned", requestCount: 0, artifacts: [] });
    expect(first.sources.map((source) => source.content)).toEqual(["Preserve existing contracts.", "Implement a settings field."]);
    await invokeOrchestration("orchestration_save_settings", { settings: { ...settings, name: "Changed defaults" }, expectedRevision: settings.revision });
    const restored = await invokeOrchestration("orchestration_get_run", { runId: first.id }) as AgentRun;
    expect(restored.settingsSnapshot.name).toBe("日常开发");
    await expect(invokeOrchestration("orchestration_save_settings", { settings, expectedRevision: settings.revision })).rejects.toThrow("STALE_SETTINGS");
  });

  it("retains prefix candidates and requires exactly one explicit recovery", async () => {
    const settings = await seed();
    const run = await create(settings.revision);
    const partial = await invokeOrchestration("orchestration_start_run", { runId: run.id, expectedRevision: run.revision }) as AgentRun;
    expect(partial).toMatchObject({ status: "partial", requestCount: 1, recoveryCount: 0 });
    expect(partial.artifacts).toHaveLength(2);
    expect(partial.artifacts[0].content).toContain("does not prove native execution");
    const recovered = await invokeOrchestration("orchestration_recover_run", { runId: run.id, expectedRevision: partial.revision }) as AgentRun;
    expect(recovered).toMatchObject({ status: "candidate", requestCount: 2, recoveryCount: 1 });
    expect(recovered.artifacts).toHaveLength(3);
    expect(recovered.artifacts.slice(0, 2)).toEqual(partial.artifacts);
    await expect(invokeOrchestration("orchestration_recover_run", { runId: run.id, expectedRevision: recovered.revision })).rejects.toThrow("RECOVERY_UNAVAILABLE");
    await expect(invokeOrchestration("orchestration_cancel_run", { runId: run.id })).rejects.toThrow("RUN_NOT_CANCELLABLE");
  });

  it("does not dispatch a revoked old resource or accept invalid worker roles", async () => {
    const settings = await seed();
    const run = await create(settings.revision);
    await expect(invokeOrchestration("orchestration_save_settings", { settings: { ...settings, workerResourceIds: ["api"] }, expectedRevision: settings.revision })).rejects.toThrow("INVALID_SETTINGS");
    await invokeOrchestration("orchestration_save_settings", { settings: { ...settings, planningResourceId: "", reviewResourceId: "", resources: [] }, expectedRevision: settings.revision });
    await expect(invokeOrchestration("orchestration_start_run", { runId: run.id, expectedRevision: run.revision })).rejects.toThrow("RESOURCE_REVOKED");
  });
});
