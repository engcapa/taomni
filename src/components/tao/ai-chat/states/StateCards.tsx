import { taoText as tr } from "../../i18n";
import { AlertTriangle, LockKeyhole, Settings2 } from "lucide-react";
import type { TaoChatController, TaoPhase } from "../ports";

export function ErrorCard({ phase, controller }: { phase: TaoPhase; controller: TaoChatController }) {
  if (phase !== "error") return null;
  return <div className="tao-home-state-card error" data-testid="tao-home-error-state"><AlertTriangle size={20} /><div><strong>{tr("本轮请求没有完成")}</strong><p>{tr("已收到的内容已保留。请检查网络或代理设置后重试。")}</p><button type="button" data-testid="tao-home-retry" onClick={() => void controller.regenerate()}>{tr("重试")}</button></div></div>;
}

export function RefusalCard({ phase }: { phase: TaoPhase }) {
  if (phase !== "refusal") return null;
  return <div className="tao-home-state-card warning" data-testid="tao-home-refusal-state"><AlertTriangle size={20} /><div><strong>{tr("安全校验未通过本次回复")}</strong><p>{tr("思考与正文已丢弃，未保存到线程。可以改写问题后重试。")}</p></div></div>;
}

export function BudgetCard({ phase, controller }: { phase: TaoPhase; controller: TaoChatController }) {
  if (phase !== "budget_halt") return null;
  return <div className="tao-home-state-card warning" data-testid="tao-home-budget-state"><strong>{tr("本轮 token 预算已用完")}</strong><p>{tr("已完成步骤已保存，续跑不会重做。")}</p><button type="button" data-testid="tao-home-continue" onClick={() => { const state = controller.getState(); const runtime = state.activeThreadId ? state.runtime[state.activeThreadId] : undefined; if (runtime) controller.increaseBudget(runtime.budget.limitTokens * 2); void controller.continueReply(); }}>{tr("提高预算并继续")}</button></div>;
}

export function StoppedCard({ phase, controller, web }: { phase: TaoPhase; controller: TaoChatController; web: boolean }) {
  if (phase !== "stopped") return null;
  const continueLabel = web ? "重新生成（联网回复无法续写）" : "继续生成";
  return <div className="tao-home-state-card warning" data-testid="tao-home-stopped-state"><AlertTriangle size={20} /><div><strong>{tr("已停止生成")}</strong><p>{tr("已收到的内容已保留，可以从当前位置继续。")}</p><button type="button" data-testid={web ? "tao-home-regenerate" : "tao-home-continue"} onClick={() => void (web ? controller.regenerate() : controller.continueReply())}>{tr(continueLabel)}</button></div></div>;
}

export function VaultLockedMask({ phase }: { phase: TaoPhase }) {
  if (phase !== "vault_locked") return null;
  return <div className="tao-home-vault-mask" data-testid="tao-home-vault-locked"><LockKeyhole size={22} /><strong>{tr("Vault 已锁定")}</strong><span>{tr("解锁后可从已收到的位置继续")}</span></div>;
}

export function BrowserUnavailableCard({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return <div className="tao-home-state-card no-key" data-testid="tao-home-no-key"><Settings2 size={24} /><div><strong>{tr("连接 DeepSeek · 全家桶")}</strong><p>{tr("浏览器预览不提供 DeepSeek 原生对话，请在桌面应用中使用。")}</p><div className="tao-home-state-actions"><button type="button" className="primary" onClick={onOpenSettings}>{tr("去设置")}</button></div></div></div>;
}
