import { taoText as tr } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, BookOpen, BrainCircuit, FileText, Files, GripVertical, PackageOpen, PanelRightClose, PanelRightOpen, Volume2, Workflow, X } from "lucide-react";
import type { ChatProfile, TaoChatController, TaoChatState } from "./ports";
import { FilesPanel } from "./FilesPanel";
import { ArchivePanel } from "./ArchivePanel";
import { SpeechPanel } from "./SpeechPanel";
import { saveExportBlob } from "../../viewer/markdown/exportFiles";
import { WorkflowPanel } from "./WorkflowPanel";
import { MemoryPanel } from "./MemoryPanel";

function panelIcon(panel: string) {
  if (panel === "来源") return <BookOpen size={13} />;
  if (panel === "文件") return <Files size={13} />;
  if (panel === "生成物") return <PackageOpen size={13} />;
  if (panel === "工作流") return <Workflow size={13} />;
  if (panel === "语音") return <Volume2 size={13} />;
  if (panel === "导入导出") return <Archive size={13} />;
  if (panel === "记忆" || panel === "技能") return <BrainCircuit size={13} />;
  return <FileText size={13} />;
}

function panelTestId(panel: string): string {
  const ids: Record<string, string> = { "来源": "sources", "文件": "files", "生成物": "artifacts", "工作流": "workflows", "语音": "voice", "导入导出": "archive", "记忆": "memory", "技能": "skills" };
  return ids[panel] ?? "other";
}

export function SidePanel({ state, profile, controller, children }: { state: TaoChatState; profile: ChatProfile; controller: TaoChatController; children?: React.ReactNode }) {
  const [width, setWidth] = useState(340);
  const [collapsed, setCollapsed] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const beginResize = useCallback((event: React.MouseEvent<HTMLButtonElement> | React.PointerEvent<HTMLButtonElement>) => {
    if (collapsed) return;
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: width };
  }, [collapsed, width]);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      const start = resizeRef.current;
      if (!start) return;
      setWidth(Math.min(560, Math.max(260, start.startWidth + start.startX - event.clientX)));
    };
    const stop = () => { resizeRef.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("pointermove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("pointerup", stop);
    };
  }, []);

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
  return <aside className="tao-home-side-panel" data-testid="tao-home-side-panel" data-collapsed={collapsed ? "true" : "false"} style={{ width: collapsed ? 44 : width }}>
    <button type="button" className="tao-home-side-resize" data-testid="tao-home-side-resize" role="separator" aria-orientation="vertical" aria-label={tr("调整侧栏宽度")} onMouseDown={beginResize} onPointerDown={beginResize}><GripVertical size={14} /></button>
    <div className="tao-home-side-tabs">
      {!collapsed ? profile.sidePanels.map((panel) => {
        const active = state.ui.sidePanel === panel;
        return <button key={panel} type="button" data-testid={`tao-home-side-tab-${panelTestId(panel)}`} className={active ? "active" : ""} aria-label={tr(panel)} title={tr(panel)} onClick={() => controller.setSidePanel(panel)}>{panelIcon(panel)}</button>;
      }) : null}
      <button type="button" className="tao-home-side-collapse" data-testid="tao-home-side-collapse" aria-label={tr(collapsed ? "展开侧栏" : "收缩侧栏")} title={tr(collapsed ? "展开侧栏" : "收缩侧栏")} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}{!collapsed ? <span>{tr("收缩侧栏")}</span> : null}</button>
      <button type="button" className="tao-home-side-close" data-testid="tao-home-side-close" aria-label={tr("关闭侧栏")} title={tr("关闭侧栏")} onClick={() => controller.setSidePanel(null)}><X size={14} />{!collapsed ? <span>{tr("关闭侧栏")}</span> : null}</button>
    </div>
    {!collapsed ? <div className="tao-home-side-content">{children ?? content}</div> : null}
  </aside>;
}
