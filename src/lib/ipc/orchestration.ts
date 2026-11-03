import { invoke } from "@tauri-apps/api/core";
import type { AppProxyConfig } from "./proxy";

export type AgentIntent = "develop" | "plan" | "review";
export type AgentProtocol = "openai_chat" | "openai_responses" | "anthropic_messages";
export type WorkerHarness = "claude_code" | "codex" | "pi" | "opencode" | "deepseek" | "zcode";
export interface AgentResource {
  id: string;
  name: string;
  kind: "api" | "worker";
  protocol: AgentProtocol;
  providerId: string;
  model: string;
  baseUrl: string;
  keyRef: string;
  harness: WorkerHarness;
  binary: string;
  args: string[];
  costCoefficient: number;
  proxyMode: "app" | "custom" | "none";
  customProxy?: AppProxyConfig | null;
}
export interface AgentSettings {
  revision: number;
  name: string;
  planningResourceId: string;
  reviewResourceId: string;
  workerResourceIds: string[];
  concurrency: number;
  preferPackedPlanning: boolean;
  resources: AgentResource[];
}
export type AgentRunStatus = "planned" | "preparing" | "running" | "partial" | "candidate" | "blocked" | "stopping" | "cancelled" | "interrupted" | "failed";
export interface AgentSource {
  id: string;
  path: string;
  content: string;
  hash: string;
}
export interface AgentArtifact {
  id: string;
  itemId: string;
  name: string;
  format: string;
  content: string;
  hash: string;
  status: "candidate";
}
export interface AgentTask {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
}
export interface AgentEvent {
  sequence: number;
  kind: string;
  message: string;
  createdAt: number;
}
export interface AgentRun {
  id: string;
  revision: number;
  projectPath: string;
  title: string;
  goal: string;
  intent: AgentIntent;
  status: AgentRunStatus;
  settingsSnapshot: AgentSettings;
  tasks: AgentTask[];
  sources: AgentSource[];
  artifacts: AgentArtifact[];
  events: AgentEvent[];
  requestCount: number;
  recoveryCount: number;
  error: string | null;
  worktreePath: string | null;
  sourceRevision?: string | null;
  createdAt: number;
}
export interface AgentSubmission {
  commandId: string;
  projectPath: string;
  goal: string;
  intent: AgentIntent;
  sourcePaths: string[];
  expectedSettingsRevision: number;
}
export interface AgentContextPreview {
  sources: AgentSource[];
  estimatedInputTokens: number;
  estimateMethod: string;
  warnings: string[];
}
export const getAgentSettings = () => invoke<AgentSettings>("orchestration_get_settings");
export const saveAgentSettings = (settings: AgentSettings, expectedRevision: number) => invoke<AgentSettings>("orchestration_save_settings", { settings, expectedRevision });
export const listAgentRuns = () => invoke<AgentRun[]>("orchestration_list_runs");
export const getAgentRun = (runId: string) => invoke<AgentRun>("orchestration_get_run", { runId });
export const createAgentRun = (submission: AgentSubmission) => invoke<AgentRun>("orchestration_create_run", { submission });
export const startAgentRun = (runId: string, expectedRevision: number) => invoke<AgentRun>("orchestration_start_run", { runId, expectedRevision });
export const cancelAgentRun = (runId: string) => invoke<AgentRun>("orchestration_cancel_run", { runId });
export const recoverAgentRun = (runId: string, expectedRevision: number) => invoke<AgentRun>("orchestration_recover_run", { runId, expectedRevision });
export const previewAgentContext = (projectPath: string, sourcePaths: string[]) => invoke<AgentContextPreview>("orchestration_preview_context", { projectPath, sourcePaths });
export const agentActiveRuns = () => invoke<number>("orchestration_active_count");
