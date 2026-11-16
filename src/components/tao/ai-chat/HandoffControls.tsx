import { useState, useSyncExternalStore } from "react";
import { useChatStore } from "../../../stores/chatStore";
import { useAiStore } from "../../../stores/aiStore";
import { useAppStore } from "../../../stores/appStore";
import { TaoPopover, useTaoPopover } from "./Popover";
import { prepareHandoff, type TaoHandoff } from "./handoff";
import type { TaoChatController } from "./ports";
import { taoText as tr } from "../i18n";

export function HandoffControls({ controller, messageId }: { controller: TaoChatController; messageId: string }) {
  const config = useAiStore((state) => state.config);
  const allowed = !config?.fully_disabled && !config?.full_local_mode;
  const acp = config?.acp_bridge.profiles.filter((p) => p.enabled) ?? [];
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const links = state.activeThreadId ? state.threads[state.activeThreadId]?.handoffs?.filter((item) => item.messageId === messageId) ?? [] : [];
  return <>
    <HandoffButton controller={controller} messageId={messageId} provider="codex" label="交给 Codex" testId="tao-home-message-codex" enabled={allowed && config?.codex_bridge.enabled === true} />
    <HandoffButton controller={controller} messageId={messageId} provider="claude-code" label="交给 Claude" testId="tao-home-message-claude" enabled={allowed && config?.cc_bridge.enabled === true} />
    {acp.length ? acp.map((profile) => <HandoffButton key={profile.id} controller={controller} messageId={messageId} provider={`acp:${profile.id}`} label={`ACP · ${profile.name}`} testId="tao-home-message-acp" enabled={allowed && config?.acp_bridge.enabled === true} />) : <button type="button" disabled title={tr("请在设置中启用对应编码 Agent")}>ACP</button>}
    {links.map((link) => <HandoffReturn key={link.targetThreadId} controller={controller} sourceThreadId={state.activeThreadId!} targetId={link.targetThreadId} provider={link.provider} />)}
  </>;
}

function HandoffButton({ controller, messageId, provider, label, testId, enabled }: { controller: TaoChatController; messageId: string; provider: string; label: string; testId: string; enabled: boolean }) {
  const popup = useTaoPopover();
  const [prepared, setPrepared] = useState<TaoHandoff>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const open = () => {
    if (popup.open) { popup.close(); return; }
    try { setPrepared(prepareHandoff(controller.getState(), messageId)); setError(""); popup.setOpen(true); }
    catch (cause) { setError(String(cause)); }
  };
  const dispatch = async () => {
    if (!prepared || busy) return;
    setBusy(true); setError("");
    try {
      const app = useAppStore.getState();
      if (prepared.linkedTabId && !app.tabs.some((tab) => tab.id === prepared.linkedTabId)) throw new Error(tr("绑定的资源已关闭，请重新选择。"));
      const target = await useChatStore.getState().newThread(provider, prepared.linkedTabId);
      controller.recordHandoff(prepared.sourceThreadId, { messageId: prepared.sourceMessageId, targetThreadId: target.id, provider, createdAt: Date.now() });
      useChatStore.getState().setDrawerOpen(true);
      if (prepared.linkedTabId) app.setActiveTab(prepared.linkedTabId);
      const outcome = await useChatStore.getState().enqueueMessage(target.id, prepared.content);
      if (outcome.status === "rejected") throw new Error(tr("交接请求未进入队列，请在目标对话重试。"));
      popup.close(false);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <>
    <button ref={popup.triggerRef} type="button" data-testid={testId} disabled={!enabled || busy} title={!enabled ? tr("请在设置中启用对应编码 Agent") : undefined} onClick={open}>{tr(label)}</button>
    <TaoPopover owner={popup} label={tr("交接编码任务")}><div className="tao-home-popup-items"><strong>{tr("交接编码任务")} · {provider}</strong><p>{tr("将发送当前对话、已选资料和执行结果；请先核对上下文。")}</p><pre data-testid="tao-home-handoff-preview" style={{ maxHeight: "40vh", overflow: "auto", whiteSpace: "pre-wrap" }}>{prepared?.content}</pre><button type="button" data-testid="tao-home-handoff-confirm" disabled={busy} onClick={() => void dispatch()}>{tr("确认交接")}</button><button type="button" onClick={() => popup.close()}>{tr("取消")}</button></div></TaoPopover>
    {error ? <p role="alert">{error}</p> : null}
  </>;
}

function HandoffReturn({ controller, sourceThreadId, targetId, provider }: { controller: TaoChatController; sourceThreadId: string; targetId: string; provider: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bringBack = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (useChatStore.getState().sendingByThreadId[targetId]) throw new Error(tr("目标 Agent 仍在执行，请完成后再带回。"));
      await useChatStore.getState().loadMessages(targetId);
      const messages = useChatStore.getState().messages[targetId] ?? [];
      const result = [...messages].reverse().find((message) => message.role === "assistant" && message.content.trim());
      if (!result) throw new Error(tr("目标 Agent 尚无可带回的回复。"));
      const source = sourceThreadId;
      if (!source || !controller.getState().threads[source]) throw new Error(tr("原 Tao 对话已关闭。"));
      controller.setActiveThread(source);
      const preview = Array.from(result.content).slice(-800).join("");
      controller.setChips([...controller.getState().composer.chips.filter((chip) => chip.id !== `handoff:${targetId}`), { id: `handoff:${targetId}`, kind: "local", label: `${tr("编码 Agent 结果")} · ${provider}`, preview, reference: `${targetId}:${result.id}`, removable: true }]);
      controller.setComposerText(tr("请根据编码 Agent 的结果继续验证和完善任务。"));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" data-testid="tao-home-handoff-return" disabled={busy} onClick={() => void bringBack()}>{tr("带回 Tao")} · {provider}</button>
    {error ? <p role="alert">{error}</p> : null}
  </>;
}
