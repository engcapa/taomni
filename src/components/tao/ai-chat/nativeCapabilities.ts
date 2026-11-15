import { invoke } from "@tauri-apps/api/core";
import type { ActionPorts, ActionProposal } from "./ports";

export function createNativeActionPorts(defaultThreadId = ""): ActionPorts {
  return {
  async execute(action: ActionProposal, threadId?: string) {
    const result = await invoke<{ status: string; actionId?: string; exitCode?: number; durationMs?: number; output?: string; undoAvailable?: boolean }>("deepseek_app_execute_action", { request: { threadId: threadId || defaultThreadId, action, confirmed: true, confirmedLevel: action.level } });
    return { actionId: result.actionId, exitCode: result.status === "completed" ? result.exitCode : result.exitCode ?? 1, durationMs: result.durationMs, output: result.output, undoAvailable: result.undoAvailable };
  },
  async reject() { return; },
  async undo(action) { await invoke("deepseek_app_undo_action", { actionId: action.result?.actionId ?? action.id, confirmed: true }); },
  };
}

export interface WorkflowDefinition { id: string; title: string; description?: string; steps?: unknown[] }
export interface WorkflowRun { id: string; title?: string; status: string; completedSteps?: number; totalSteps?: number; error?: string }
export interface MemoryEntry { id?: string; kind: "memory" | "soul" | "skill"; title: string; content: string; enabled: boolean; updatedAt?: number }

export const nativeCapabilities = {
  listWorkflows: () => invoke<WorkflowDefinition[]>("deepseek_app_workflows"),
  listRuns: (threadId?: string) => invoke<WorkflowRun[]>("deepseek_app_workflow_runs", { threadId }),
  createWorkflow: (threadId: string, definitionId: string, _steps: ActionProposal[] = []) => invoke<WorkflowRun>("deepseek_app_create_workflow", { threadId, definitionId }),
  advanceWorkflow: (runId: string, confirmed: boolean, confirmedLevel?: string, skip?: boolean) => invoke<WorkflowRun>("deepseek_app_advance_workflow", { runId, confirmed, confirmedLevel, skip }),
  cancelWorkflow: (runId: string) => invoke("deepseek_app_cancel_workflow", { runId }),
  listMemory: () => invoke<MemoryEntry[]>("deepseek_app_memory_list"),
  saveMemory: (entry: MemoryEntry) => invoke("deepseek_app_memory_save", { entry, confirmed: true }),
  deleteMemory: (id: string) => invoke("deepseek_app_memory_delete", { id, confirmed: true }),
  exportMemory: () => invoke<MemoryEntry[]>("deepseek_app_memory_export"),
};
