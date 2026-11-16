import { taoText as tr } from "../i18n";
import { useEffect, useRef } from "react";
import { PanelRightClose, PanelRightOpen, Plus, Presentation, Search } from "lucide-react";
import { getAppPlatform } from "../../../lib/runtime";
import { TaoPopover, useTaoPopover } from "./Popover";
import type { ChatProfile, TaoChatController, TaoChatState, TaoMode } from "./ports";

export function TopBar({ state, profile, controller, onMode, onSearch, slots }: {
  state: TaoChatState; profile: ChatProfile; controller: TaoChatController;
  onMode: (mode: TaoMode) => void; onSearch: () => void; onOpenSettings?: () => void; onOpenAppearance?: () => void; slots?: React.ReactNode;
}) {
  const usage = useTaoPopover();
  const lastPanel = useRef(profile.sidePanels[0]);
  useEffect(() => { if (state.ui.sidePanel) lastPanel.current = state.ui.sidePanel; }, [state.ui.sidePanel]);
  const togglePanel = () => controller.setSidePanel(state.ui.sidePanel ? null : lastPanel.current ?? profile.sidePanels[0] ?? null);
  const runtime = state.activeThreadId ? state.runtime[state.activeThreadId] : undefined;
  const budget = runtime?.budget;
  const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
  const totals = thread?.messages.flatMap((message) => message.blocks).filter((block) => block.type === "usage").map((block) => block.usage);
  return <header className="tao-home-topbar" data-testid="tao-home-topbar">
    <div className="tao-home-mode-segment" role="tablist" aria-label={tr("Tao 模式")}>{profile.modes.map((mode) => <button key={mode.id} type="button" role="tab" aria-selected={state.mode === mode.id} data-testid={`tao-home-mode-${mode.id}`} className={state.mode === mode.id ? "is-active" : ""} title={mode.description ? tr(mode.description) : undefined} onClick={() => onMode(mode.id)}>{tr(mode.label)}</button>)}</div>
    <div className="tao-home-topbar-leading">{slots}</div>
    <div className="tao-home-topbar-actions">
      <button type="button" className="tao-home-icon-button tao-home-new-chat" data-testid="tao-home-new-chat" onClick={() => controller.createThread()}><Plus size={15} />{tr("新 Tao 对话")}</button>
      {budget && budget.usedTokens > 0 ? <button ref={usage.triggerRef} type="button" className={`tao-home-usage-pill warning-${budget.warning ?? 0}`} data-testid="tao-home-usage-pill" onClick={() => usage.setOpen(!usage.open)}>{formatTokens(budget.usedTokens)} / {formatTokens(budget.limitTokens)}</button> : null}
      <TaoPopover owner={usage} label={tr("用量与预算")}><div className="tao-home-popup-items"><strong>{tr("用量与预算")}</strong>{totals?.map((item, index) => <p key={index}>{tr("第 {n} 轮", { n: index + 1 })} · {tr("输入")} {item?.inputTokens ?? tr("未知")} / {tr("输出")} {item?.outputTokens ?? tr("未知")}<br />{tr("搜索")} {item?.searchCalls ?? tr("未知")} · {tr("读链接")} {item?.fetchCalls ?? tr("未知")}<br />{item?.estimatedCostCny === undefined ? tr("费用未知") : tr("约 ¥{amount}（估算）", { amount: item.estimatedCostCny.toFixed(4) })}</p>)}<p>{tr("本轮")} {budget?.usedTokens ?? 0} / {budget?.limitTokens ?? 0} tokens</p></div></TaoPopover>
      <button type="button" className="tao-home-icon-button" data-testid="tao-home-search" aria-label={tr("搜索 Taomni 本地资料")} onClick={onSearch}><Search size={15} /><kbd>{getAppPlatform() === "macos" ? "⌘K" : "Ctrl+K"}</kbd></button>
      <button type="button" className="tao-home-icon-button" data-testid="tao-home-demo-toggle" aria-label={tr("演示模式")} title={`${tr("演示模式")} · F9`} aria-pressed={state.ui.demoMode} onClick={() => controller.setDemoMode(!state.ui.demoMode)}><Presentation size={15} /></button>
      {profile.sidePanels.length ? <button type="button" className="tao-home-icon-button" data-testid="tao-home-side-toggle" aria-label={tr(state.ui.sidePanel ? "收缩侧栏" : "展开侧栏")} title={tr(state.ui.sidePanel ? "收缩侧栏" : "展开侧栏")} aria-expanded={Boolean(state.ui.sidePanel)} onClick={togglePanel}>{state.ui.sidePanel ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button> : null}
    </div>
  </header>;
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}
