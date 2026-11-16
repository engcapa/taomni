import { taoText as tr } from "../i18n";
import { Check, ChevronDown, ChevronRight, Clipboard, Play, RotateCcw, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ActionProposal, TaoBlock, TaoChatController, TaoMessage, TaoPhase, TaoThread } from "./ports";
import { MarkdownReply } from "./MarkdownReply";
import { useChatStore } from "../../../stores/chatStore";
import { useAiStore } from "../../../stores/aiStore";
import { isTauriRuntime } from "../../../lib/runtime";
import { speakTao, stopTaoSpeech } from "./SpeechPanel";

export function MessageList({ thread, phase, controller }: { thread?: TaoThread; phase?: TaoPhase; controller: TaoChatController }) {
  if (!thread || thread.messages.length === 0) return null;
  return <div className="tao-home-message-list" data-testid="tao-home-message-list">{thread.messages.map((message) => <Message key={message.id} message={message} phase={phase} controller={controller} />)}</div>;
}

function Message({ message, phase, controller }: { message: TaoMessage; phase?: TaoPhase; controller: TaoChatController }) {
  const user = message.role === "user";
  const [handoffError, setHandoffError] = useState("");
  const voice = useAiStore((state) => state.config?.deepseek_app?.tts_voice ?? "stella");
  const handoff = async (providerId: "codex" | "claude-code") => {
    try {
      const thread = await useChatStore.getState().newThread(providerId);
      await useChatStore.getState().sendMessage(thread.id, message.text);
    } catch (error) {
      setHandoffError(String(error));
    }
  };
  return (
    <article className={`tao-home-message ${user ? "user" : "assistant"}`} data-testid={`tao-home-message-${message.role}`}>
      <div className="tao-home-message-avatar">{user ? tr("你") : "T"}</div>
      <div className="tao-home-message-body">
        {user ? <div className="tao-home-message-text">{message.text}</div> : <AssistantBlocks message={message} phase={phase} controller={controller} />}
        <div className="tao-home-message-actions"><button type="button" aria-label={tr("复制")} onClick={() => void navigator.clipboard?.writeText(message.text)}><Clipboard size={13} /></button>{user ? <button type="button" data-testid="tao-home-message-edit" aria-label={tr("编辑")} onClick={() => { controller.branchAt(message.id, message.text); }}><RotateCcw size={13} />{tr("编辑")}</button> : <><button type="button" data-testid="tao-home-message-regenerate" aria-label={tr("重新生成")} onClick={() => void controller.regenerate()}><RotateCcw size={13} />{tr("重新生成")}</button><button type="button" data-testid="tao-home-message-branch" aria-label={tr("创建分支")} onClick={() => { controller.branchAt(message.id); }}><RotateCcw size={13} />{tr("分支")}</button><button type="button" data-testid="tao-home-message-speak" aria-label={tr("朗读")} disabled={!isTauriRuntime()} onClick={() => void speakTao(message.text, voice).catch((error) => setHandoffError(String(error)))}>{tr("朗读")}</button><button type="button" data-testid="tao-home-message-stop-speak" aria-label={tr("停止朗读")} onClick={() => void stopTaoSpeech().catch((error) => setHandoffError(String(error)))}>{tr("停止朗读")}</button><button type="button" data-testid="tao-home-message-codex" onClick={() => void handoff("codex")}>{tr("交给 Codex")}</button><button type="button" data-testid="tao-home-message-claude" onClick={() => void handoff("claude-code")}>{tr("交给 Claude")}</button></>}</div>{handoffError ? <p role="alert">{handoffError}</p> : null}
      </div>
    </article>
  );
}

function AssistantBlocks({ message, phase, controller }: { message: TaoMessage; phase?: TaoPhase; controller: TaoChatController }) {
  const blocks = message.blocks;
  if (blocks.length === 0 && message.text) return <MarkdownReply text={message.text} />;
  return <div className="tao-home-blocks">{blocks.map((block) => <Block key={block.id} block={block} phase={phase} controller={controller} />)}{phase === "streaming" ? <span className="tao-home-stream-cursor" /> : null}</div>;
}

function Block({ block, phase, controller }: { block: TaoBlock; phase?: TaoPhase; controller: TaoChatController }) {
  const [expanded, setExpanded] = useBlockExpansion(block, phase);
  if (block.type === "thinking") return <div className="tao-home-thinking-block"><button type="button" onClick={() => setExpanded(!expanded)}><span className="tao-home-thinking-dot" />{tr("已思考")} {tr(expanded ? "· 展开" : "· 点击查看")}{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>{expanded ? <p>{block.text}</p> : null}</div>;
  if (block.type === "search") return <div className={`tao-home-search-step ${block.status === "error" ? "error" : ""}`}><span>{tr(block.status === "running" ? "正在搜索" : "已找到来源")}</span>{block.query ? `: ${block.query}` : ""}</div>;
  if (block.type === "sources") return <div className="tao-home-sources">{(block.sources ?? []).map((source) => <a key={source.id} href={source.url ?? "#"} onClick={(event) => { if (!source.url) { event.preventDefault(); controller.setSidePanel("来源"); } }}><strong>{source.title}</strong><span>{source.site ?? tr(source.local ? "本地资料" : "来源")}</span></a>)}</div>;
  if (block.type === "action" && block.action) return <ActionCard action={block.action} controller={controller} />;
  if (block.type === "usage" && block.usage) return <div className="tao-home-usage-line">{tr("输入")} {block.usage.inputTokens} · {tr("输出")} {block.usage.outputTokens} · {tr("搜索")} {block.usage.searchCalls} · {tr("读链接")} {block.usage.fetchCalls} · {block.usage.estimatedCostCny === undefined ? tr("费用未知") : tr("约 ¥{amount}（估算）", { amount: block.usage.estimatedCostCny.toFixed(4) })}</div>;
  if (block.type === "error" && block.error) {
    if (phase === "vault_locked" && block.error.category === "vault_locked") return null;
    if (phase === "refusal" && block.error.category === "configuration") return null;
    return <div className="tao-home-error-card" data-testid="tao-home-error-state"><strong>{tr(block.error.category === "network" ? "网络不可用" : block.error.category === "interrupted" ? "流中断" : block.error.category === "protocol" ? "请求参数无效" : block.error.category === "configuration" ? "配置不可用" : "Tao 暂时无法完成")}</strong><p>{block.error.message}</p><button type="button" data-testid="tao-home-retry" onClick={() => void controller.regenerate()}>{tr("重试")}</button></div>;
  }
  if (block.type === "plan") return <div className="tao-home-plan-card"><strong>{tr("工作流计划")}</strong>{(block.steps ?? []).map((step) => <div key={step.id}><span className={`step-${step.status}`} />{step.label}</div>)}</div>;
  return block.text ? <MarkdownReply text={block.text} /> : null;
}

function ActionCard({ action, controller }: { action: ActionProposal; controller: TaoChatController }) {
  const [editing, setEditing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const original = action.payload.command ?? action.payload.sql ?? action.payload.path ?? "";
  const [draft, setDraft] = useState(original);
  const editedAction = draft === original ? action : {
    ...action,
    payload: action.kind === "run_sql" ? { ...action.payload, sql: draft } : action.kind === "write_file" ? { ...action.payload, path: draft } : { ...action.payload, command: draft },
  };
  if (action.status === "completed" || action.status === "rejected" || action.status === "invalid" || action.status === "undone") return <div className="tao-home-action-card" data-testid="tao-home-action-result"><strong>{action.title} · {tr(action.status === "completed" ? "已完成" : action.status === "rejected" ? "已拒绝" : action.status === "undone" ? "已撤销" : "执行失败")}</strong>{action.result ? <pre>{action.result.exitCode === undefined ? "" : `exit ${action.result.exitCode}\n`}{action.result.output}{action.result.durationMs === undefined ? "" : `\n${action.result.durationMs}ms`}</pre> : null}{action.status === "completed" && action.result?.undoAvailable ? <button type="button" data-testid="tao-home-action-undo" onClick={() => void controller.undoAction(action)}>{tr("撤销")}</button> : null}</div>;
  return <div className={`tao-home-action-card level-${action.level}`} data-testid="tao-home-action-card"><div className="tao-home-action-heading"><strong>{action.title}</strong><span>{action.level}</span></div><p>{action.reason}</p>{editing ? <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={tr("编辑动作")} /> : <pre>{draft}</pre>}<label className="tao-home-action-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{tr("我已确认命令内容")}</label><div className="tao-home-action-buttons"><button type="button" className="primary" disabled={editedAction.level === "L2" && !confirmed} onClick={() => void controller.approveAction(editedAction)}><Play size={13} />{tr("执行")}</button><button type="button" onClick={() => void controller.rejectAction(action)}><X size={13} />{tr("拒绝")}</button><button type="button" onClick={() => setEditing(!editing)}>{editing ? <Check size={13} /> : <Undo2 size={13} />} {tr(editing ? "执行编辑内容" : "编辑后执行")}</button></div></div>;
}

function useBlockExpansion(block: TaoBlock, phase?: TaoPhase): [boolean, (expanded: boolean) => void] {
  const [expanded, setExpanded] = useState(block.manuallyExpanded ?? (phase === "thinking" && block.status === "running"));
  const [manual, setManual] = useState(Boolean(block.manuallyExpanded));
  const previousPhase = useRef(phase);
  useEffect(() => {
    const wasThinking = previousPhase.current === "thinking";
    previousPhase.current = phase;
    if (manual || !wasThinking || phase === "thinking") return;
    const timer = window.setTimeout(() => setExpanded(false), 600);
    return () => window.clearTimeout(timer);
  }, [manual, phase, block.id]);
  return [expanded, (next) => { setManual(true); setExpanded(next); }];
}
