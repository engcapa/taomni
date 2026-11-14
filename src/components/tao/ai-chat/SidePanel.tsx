import { FileText, PanelRightClose } from "lucide-react";
import type { ChatProfile, TaoChatController, TaoChatState } from "./ports";

export function SidePanel({ state, profile, controller, children }: { state: TaoChatState; profile: ChatProfile; controller: TaoChatController; children?: React.ReactNode }) {
  if (!state.ui.sidePanel) return null;
  return <aside className="tao-home-side-panel" data-testid="tao-home-side-panel"><div className="tao-home-side-tabs">{profile.sidePanels.map((panel) => <button key={panel} type="button" className={state.ui.sidePanel === panel ? "active" : ""} onClick={() => controller.setSidePanel(panel)}><FileText size={13} />{panel}</button>)}<button type="button" aria-label="关闭侧栏" onClick={() => controller.setSidePanel(null)}><PanelRightClose size={14} /></button></div><div className="tao-home-side-content">{children ?? <p>选择一条来源或生成物查看详情。</p>}</div></aside>;
}
