import { vi } from "vitest";
import * as ipc from "../../../../lib/ipc/orchestration";
import { setLocale } from "../../../../lib/i18n";
import { useAiStore } from "../../../../stores/aiStore";
import { DEFAULT_CONFIG } from "../../../../stores/ai/defaults";
import { useOrchestrationStore } from "../../../../stores/orchestrationStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../../stores/workspacePlatformStore";

export function settingsFixture(): ipc.AgentSettings {
  return {
    revision: 3, name: "Daily development", planningResourceId: "api", reviewResourceId: "api",
    workerResourceIds: ["cli"], concurrency: 2, preferPackedPlanning: true,
    resources: [
      { id: "api", name: "Planning API", kind: "api", protocol: "openai_chat", providerId: "fixture-provider", model: "fixture-model", baseUrl: "https://provider.test/v1", keyRef: "vault:provider-key", harness: "claude_code", binary: "", args: [], costCoefficient: 1, proxyMode: "app", customProxy: null },
      { id: "cli", name: "Local worker", kind: "worker", protocol: "anthropic_messages", providerId: "", model: "", baseUrl: "", keyRef: "", harness: "claude_code", binary: "claude", args: [], costCoefficient: 1, proxyMode: "app", customProxy: null },
    ],
  };
}

export function runFixture(update: Partial<ipc.AgentRun> = {}): ipc.AgentRun {
  return {
    id: "run-1", revision: 2, projectPath: "/project", title: "Project settings", goal: "Implement project settings", intent: "develop", status: "planned",
    settingsSnapshot: settingsFixture(), tasks: [{ id: "design", title: "Design the change", status: "pending", dependencies: [] }],
    sources: [{ id: "rules", path: "AGENTS.md", content: "Preserve existing IPC contracts.", hash: "rules-hash" }], artifacts: [], events: [],
    requestCount: 0, recoveryCount: 0, error: null, worktreePath: null, createdAt: 1,
    ...update,
  };
}

export function resetOrchestrationHarness() {
  vi.resetAllMocks();
  localStorage.clear();
  setLocale("en");
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/project", name: "project" });
  useOrchestrationStore.setState({ settings: null, runs: [], projectPath: "", selectedRunId: null, loading: false, saving: false, pending: null, error: null });
  useAiStore.setState({ config: { ...structuredClone(DEFAULT_CONFIG), llm: { ...structuredClone(DEFAULT_CONFIG.llm), providers: {
    "fixture-provider": { base_url: "https://provider.test/v1", api_key: "vault:provider-key", model: "fixture-model", runtime: "openai-compat" },
    "unsafe-provider": { base_url: "https://unsafe.test/v1", api_key: "plaintext-secret", model: "unsafe-model", runtime: "openai-compat" },
  } } }, loading: false });
  vi.mocked(ipc.getAgentSettings).mockResolvedValue(settingsFixture());
  vi.mocked(ipc.listAgentRuns).mockResolvedValue([]);
  vi.mocked(ipc.getAgentRun).mockResolvedValue(runFixture());
  vi.mocked(ipc.createAgentRun).mockResolvedValue(runFixture());
  vi.mocked(ipc.startAgentRun).mockResolvedValue(runFixture({ revision: 3, status: "running", requestCount: 1 }));
  vi.mocked(ipc.cancelAgentRun).mockResolvedValue(runFixture({ revision: 4, status: "stopping" }));
  vi.mocked(ipc.recoverAgentRun).mockResolvedValue(runFixture({ revision: 5, status: "running", requestCount: 2, recoveryCount: 1 }));
  vi.mocked(ipc.saveAgentSettings).mockImplementation(async (settings) => ({ ...settings, revision: settings.revision + 1 }));
  vi.mocked(ipc.previewAgentContext).mockResolvedValue({ sources: runFixture().sources, estimatedInputTokens: 25, estimateMethod: "fixture", warnings: [] });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
