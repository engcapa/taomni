import { Check, ChevronDown, ChevronRight, Clipboard, Play, RotateCcw, ThumbsDown, ThumbsUp, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ActionProposal, TaoBlock, TaoChatController, TaoMessage, TaoPhase, TaoThread } from "./ports";

export function MessageList({ thread, phase, controller }: { thread?: TaoThread; phase?: TaoPhase; controller: TaoChatController }) {
  if (!thread || thread.messages.length === 0) return null;
  return <div className="tao-home-message-list" data-testid="tao-home-message-list">{thread.messages.map((message) => <Message key={message.id} message={message} phase={phase} controller={controller} />)}</div>;
}

function Message({ message, phase, controller }: { message: TaoMessage; phase?: TaoPhase; controller: TaoChatController }) {
  const user = message.role === "user";
  return (
    <article className={`tao-home-message ${user ? "user" : "assistant"}`} data-testid={`tao-home-message-${message.role}`}>
      <div className="tao-home-message-avatar">{user ? "你" : "T"}</div>
      <div className="tao-home-message-body">
        {user ? <div className="tao-home-message-text">{message.text}</div> : <AssistantBlocks message={message} phase={phase} controller={controller} />}
        {!user ? <div className="tao-home-message-actions"><button type="button" aria-label="复制" onClick={() => void navigator.clipboard?.writeText(message.text)}><Clipboard size={13} /></button><button type="button" aria-label="赞同"><ThumbsUp size={13} /></button><button type="button" aria-label="不赞同"><ThumbsDown size={13} /></button><button type="button" aria-label="重新生成" onClick={() => void controller.regenerate()}><RotateCcw size={13} /></button></div> : null}
      </div>
    </article>
  );
}

function AssistantBlocks({ message, phase, controller }: { message: TaoMessage; phase?: TaoPhase; controller: TaoChatController }) {
  const blocks = message.blocks;
  if (blocks.length === 0 && message.text) return <div className="tao-home-message-text">{message.text}</div>;
  return <div className="tao-home-blocks">{blocks.map((block) => <Block key={block.id} block={block} phase={phase} controller={controller} />)}{phase === "streaming" ? <span className="tao-home-stream-cursor" /> : null}</div>;
}

function Block({ block, phase, controller }: { block: TaoBlock; phase?: TaoPhase; controller: TaoChatController }) {
  const [expanded, setExpanded] = useBlockExpansion(block, phase);
  if (block.type === "thinking") return <div className="tao-home-thinking-block"><button type="button" onClick={() => setExpanded(!expanded)}><span className="tao-home-thinking-dot" />已思考 {expanded ? "· 展开" : "· 点击查看"}{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>{expanded ? <p>{block.text}</p> : null}</div>;
  if (block.type === "search") return <div className={`tao-home-search-step ${block.status === "error" ? "error" : ""}`}><span>{block.status === "running" ? "正在搜索" : "已找到来源"}</span>{block.query ? `：${block.query}` : ""}</div>;
  if (block.type === "sources") return <div className="tao-home-sources">{(block.sources ?? []).slice(0, 3).map((source) => <a key={source.id} href={source.url ?? "#"} onClick={(event) => { if (!source.url) event.preventDefault(); }}><strong>{source.title}</strong><span>{source.site ?? (source.local ? "本地资料" : "来源")}</span></a>)}</div>;
  if (block.type === "action" && block.action) return <ActionCard action={block.action} controller={controller} />;
  if (block.type === "usage" && block.usage) return <div className="tao-home-usage-line">输入 {block.usage.inputTokens} · 输出 {block.usage.outputTokens} · 搜索 {block.usage.searchCalls} · 抓取 {block.usage.fetchCalls} · {block.usage.estimatedCostCny === undefined ? "金额未估算" : `约 ¥${block.usage.estimatedCostCny.toFixed(2)}（估算）`}</div>;
  if (block.type === "error" && block.error) return <div className="tao-home-error-card"><strong>{block.error.category === "network" ? "网络不可用" : block.error.category === "interrupted" ? "流中断" : "Tao 暂时无法完成"}</strong><p>{block.error.message}</p><button type="button" onClick={() => void controller.regenerate()}>重试</button></div>;
  if (block.type === "plan") return <div className="tao-home-plan-card"><strong>工作流计划</strong>{(block.steps ?? []).map((step) => <div key={step.id}><span className={`step-${step.status}`} />{step.label}</div>)}</div>;
  return block.text ? <div className="tao-home-message-text">{block.text}</div> : null;
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
  return <div className={`tao-home-action-card level-${action.level}`} data-testid="tao-home-action-card"><div className="tao-home-action-heading"><strong>{action.title}</strong><span>{action.level}</span></div><p>{action.reason}</p>{editing ? <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="编辑动作" /> : <pre>{draft}</pre>}<label className="tao-home-action-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已确认命令内容</label><div className="tao-home-action-buttons"><button type="button" className="primary" disabled={editedAction.level === "L2" && !confirmed} onClick={() => void controller.approveAction(editedAction)}><Play size={13} />执行</button><button type="button" onClick={() => void controller.rejectAction(action)}><X size={13} />拒绝</button><button type="button" onClick={() => setEditing(!editing)}>{editing ? <Check size={13} /> : <Undo2 size={13} />} {editing ? "执行编辑内容" : "编辑后执行"}</button></div></div>;
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
