import { useEffect, useState } from "react";
import { isTauriRuntime } from "../../../lib/runtime";
import { taoText as tr } from "../i18n";
import { nativeCapabilities, type WorkflowDefinition, type WorkflowRun } from "./nativeCapabilities";
import type { TaoChatController } from "./ports";

const BUILT_IN_TITLES: Record<string, string> = {
  deep_research: "深研", code_review: "代码 review", sql_investigate: "SQL 排查",
  troubleshoot: "故障排查", file_organize: "文件整理",
};
const WORKFLOW_STATUS_LABELS: Record<string, string> = {
  pending: "待处理", running: "运行中", completed: "已完成", done: "已完成", cancelled: "已取消", failed: "失败", skipped: "跳过",
};

export function WorkflowPanel({ controller }: { controller: TaoChatController }) {
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState("");
  const threadId = controller.getState().activeThreadId;
  const refresh = () => { if (!isTauriRuntime()) return; void Promise.all([nativeCapabilities.listWorkflows(), nativeCapabilities.listRuns(threadId ?? undefined)]).then(([items, active]) => { setDefinitions(items); setRuns(active); }).catch((cause) => setError(String(cause))); };
  useEffect(() => { refresh(); }, [threadId]);
  const execute = async (definition: WorkflowDefinition) => { if (!threadId) return; try { const run = await nativeCapabilities.createWorkflow(threadId, definition.id, []); setRuns((current) => [run, ...current]); } catch (cause) { setError(String(cause)); } };
  return <section data-testid="tao-home-workflows"><h3>{tr("工作流")}</h3><p>{tr("每一步都需确认；关闭侧栏后仍可在后台恢复。")}</p>{definitions.map((definition) => <article key={definition.id}><strong>{BUILT_IN_TITLES[definition.id] ? tr(BUILT_IN_TITLES[definition.id]) : definition.title}</strong><p>{definition.description}</p><button type="button" disabled={!isTauriRuntime()} onClick={() => void execute(definition)}>{tr("开始")}</button></article>)}{runs.map((run) => <article key={run.id} data-testid="tao-home-workflow-run"><strong>{run.title ?? run.id}</strong><span>{tr(WORKFLOW_STATUS_LABELS[run.status] ?? run.status)}</span>{run.status === "running" ? <button type="button" onClick={() => void nativeCapabilities.cancelWorkflow(run.id).then(refresh)}>{tr("取消")}</button> : null}</article>)}{!definitions.length && !runs.length ? <p>{tr("暂无可用工作流")}</p> : null}{error ? <p role="alert">{error}</p> : null}</section>;
}
