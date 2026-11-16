import { taoText as tr } from "../i18n";
import { GripVertical } from "lucide-react";
import type { ChatProfile, TaoChatController, TaoChatState } from "./ports";
import { FilesPanel } from "./FilesPanel";
import { ArchivePanel } from "./ArchivePanel";
import { SpeechPanel } from "./SpeechPanel";
import { saveExportBlob } from "../../viewer/markdown/exportFiles";
import { WorkflowPanel } from "./WorkflowPanel";
import { MemoryPanel } from "./MemoryPanel";
import { sidePanelTab } from "./sidePanelTabs";
import { useSidePanelResize } from "./useSidePanelResize";

export function SidePanel({ state, profile, controller, children }: { state: TaoChatState; profile: ChatProfile; controller: TaoChatController; children?: React.ReactNode }) {
  const { panelRef, width, resizing, beginResize, onKeyDown, resetWidth } = useSidePanelResize(Boolean(state.ui.sidePanel));

  if (!state.ui.sidePanel) return null;
  const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
  const sources = thread?.messages.flatMap((message) => message.blocks.flatMap((block) => block.sources ?? [])) ?? [];
  const artifacts = thread?.messages.filter((message) => message.role === "assistant" && message.text.trim()) ?? [];
  const content = state.ui.sidePanel === "文件" ? <FilesPanel controller={controller} />
    : state.ui.sidePanel === "导入导出" ? <ArchivePanel controller={controller} />
    : state.ui.sidePanel === "语音" ? <SpeechPanel controller={controller} />
    : state.ui.sidePanel === "来源" ? <section data-testid="tao-home-sources">{sources.length ? sources.map((source) => <article key={source.id} id={`tao-source-${source.id}`}><strong>{state.ui.demoMode ? tr("来源") : source.title}</strong>{!state.ui.demoMode ? <p>{source.summary}</p> : null}{source.url && !state.ui.demoMode ? <a href={source.url} target="_blank" rel="noreferrer">{tr("打开")}</a> : null}</article>) : <p>{tr("本轮没有来源。")}</p>}</section>
    : state.ui.sidePanel === "生成物" ? <section data-testid="tao-home-artifacts">{artifacts.length ? artifacts.map((message, index) => <article key={message.id}><strong>{tr("回复 {index}", { index: index + 1 })}</strong><button type="button" onClick={() => void saveExportBlob(`tao-${message.id}.md`, new Blob([message.text], { type: "text/markdown" }))}>{tr("保存 Markdown")}</button></article>) : <p>{tr("暂无生成物")}</p>}</section>
    : state.ui.sidePanel === "工作流" ? <WorkflowPanel controller={controller} />
    : state.ui.sidePanel === "记忆" || state.ui.sidePanel === "技能" ? <MemoryPanel controller={controller} />
    : <p>{tr("选择一条来源或生成物查看详情。")}</p>;
  return <aside ref={panelRef} className="tao-home-side-panel" data-testid="tao-home-side-panel" data-resizing={resizing} style={{ width }}>
    <button type="button" className="tao-home-side-resize" data-testid="tao-home-side-resize" role="separator" aria-orientation="vertical" aria-label={tr("调整侧栏宽度")} aria-valuenow={Math.round(width)} onMouseDown={beginResize} onPointerDown={beginResize} onKeyDown={onKeyDown} onDoubleClick={resetWidth}><GripVertical size={14} /></button>
    <div className="tao-home-side-tabs" role="tablist" aria-label={tr("Tao 侧栏")}>
      {profile.sidePanels.map((panel) => {
        const active = state.ui.sidePanel === panel;
        const { id, Icon } = sidePanelTab(panel);
        return <button key={panel} type="button" role="tab" aria-selected={active} data-testid={`tao-home-side-tab-${id}`} className={active ? "active" : ""} aria-label={tr(panel)} title={tr(panel)} onClick={() => controller.setSidePanel(panel)}><Icon size={15} /></button>;
      })}
    </div>
    <div className="tao-home-side-content">{children ?? content}</div>
  </aside>;
}
