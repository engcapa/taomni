import { taoText as tr } from "../../i18n";
import { AlertTriangle, LockKeyhole, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useVaultGate } from "../../../../lib/vaultGate";
import { useVaultStore } from "../../../../stores/vaultStore";
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

export function StoppedCard({ phase, controller, web, received = true }: { phase: TaoPhase; controller: TaoChatController; web: boolean; received?: boolean }) {
  if (phase !== "stopped") return null;
  const regenerate = web || !received;
  const continueLabel = web ? "重新生成（联网回复无法续写）" : received ? "继续生成" : "重新生成";
  return <div className="tao-home-state-card warning" data-testid="tao-home-stopped-state"><AlertTriangle size={20} /><div><strong>{tr("已停止生成")}</strong><p>{tr(received ? "已收到的内容已保留，可以从当前位置继续。" : "本轮尚未收到回复，可重新生成。")}</p><button type="button" data-testid={regenerate ? "tao-home-regenerate" : "tao-home-continue"} onClick={() => void (regenerate ? controller.regenerate() : controller.continueReply())}>{tr(continueLabel)}</button></div></div>;
}

export function VaultLockedMask({ phase, controller, active = true, compact = false }: { phase: TaoPhase; controller: TaoChatController; active?: boolean; compact?: boolean }) {
  const ensureVaultReady = useVaultGate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active && phase === "vault_locked" && !busy && !compact) button.current?.focus();
  }, [active, phase, busy, compact]);
  if (phase !== "vault_locked") return null;
  const unlock = async () => {
    const threadId = controller.getState().activeThreadId;
    if (!threadId || busy) return;
    setBusy(true);
    setError("");
    try {
      // Auto-lock may have made the UI's store stale. Refresh before the gate's
      // unlocked fast path, and retain the original thread across the dialog.
      await useVaultStore.getState().refresh();
      if (await ensureVaultReady(tr("解锁后可从已收到的位置继续"))) controller.acknowledgeVaultUnlock(threadId);
    } catch (cause) {
      setError(tr("无法解锁 Vault：{error}", { error: String(cause) }));
    } finally {
      setBusy(false);
    }
  };
  return <div className={compact ? "tao-home-state-card warning tao-home-vault-notice" : "tao-home-vault-mask"} data-testid={compact ? "tao-home-vault-notice" : "tao-home-vault-locked"} role="status">
    <LockKeyhole size={22} /><strong>{tr("Vault 已锁定")}</strong><span>{tr("解锁后可从已收到的位置继续")}</span>
    <button ref={button} type="button" data-testid="tao-home-vault-unlock" disabled={busy} onClick={() => void unlock()}>{tr("解锁 Vault")}</button>
    {!compact ? <button type="button" data-testid="tao-home-vault-dismiss" disabled={busy} onClick={() => { const id = controller.getState().activeThreadId; if (id) controller.dismissVaultPrompt(id); }}>{tr("暂时跳过")}</button> : null}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function BrowserUnavailableCard({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return <div className="tao-home-state-card no-key" data-testid="tao-home-no-key"><Settings2 size={24} /><div><strong>{tr("连接 DeepSeek · 全家桶")}</strong><p>{tr("浏览器预览不提供 DeepSeek 原生对话，请在桌面应用中使用。")}</p><div className="tao-home-state-actions"><button type="button" className="primary" onClick={onOpenSettings}>{tr("去设置")}</button></div></div></div>;
}
