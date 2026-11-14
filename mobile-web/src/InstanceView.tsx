import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, errorText, loadInstances, request, saveInstances, statusText, type Instance, type Session, type SessionList } from "./api";
import { SavedSessionsPanel } from "./SavedSessionsPanel";
import { SessionResults } from "./SessionResults";
import { useLive } from "./live";
import { isSessionList } from "./apiContracts";
import { openSession, type OpenTarget, type OpenStatus } from "./openSession";
import { ConnectionAuthForm } from "./ConnectionAuthForm";
import { DesktopView } from "./DesktopView";
import { TaskView } from "./TaskView";
import { TerminalView } from "./TerminalView";

const terminalSearchText = (session: Session) => [session.title, session.summary];

/** A session id from a link or a fresh open may not be in the list yet; its prefix says what it is. */
function placeholder(id: string, title: string): Session {
  return { id, kind: id.startsWith("thread:") ? "agent" : "terminal", title, status: "running", summary: "" };
}

export function InstanceView({ instance, sessionId, desktop, onSelect, onOpenDesktop, onCloseDesktop, onCloseSession, onBack }: {
  instance: Instance;
  sessionId?: string;
  desktop?: boolean;
  onSelect: (sessionId: string) => void;
  onOpenDesktop?: () => void;
  onCloseDesktop?: () => void;
  onCloseSession: () => void;
  onBack: () => void;
}) {
  const [data, setData] = useState<SessionList>({ sessions: [], saved_sessions: [] });
  const [status, setStatus] = useState("连接中");
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState("");
  const [revision, setRevision] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState("");
  const [openProgress, setOpenProgress] = useState<OpenStatus | null>(null);
  const terminalSessions = useMemo(() => data.sessions.filter(session => session.kind === "terminal"), [data.sessions]);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const openAbort = useRef<AbortController | null>(null);
  const known = useRef<Session | null>(null);
  const refresh = useCallback(() => {
    const current = ++generation.current;
    abort.current?.abort(); abort.current = new AbortController();
    void request<SessionList>(instance, "/sessions", undefined, abort.current.signal).then(value => {
      if (current !== generation.current) return;
      if (!isSessionList(value)) throw new ApiError("invalid_api_response");
      try {
        const saved = loadInstances().map(v => v.id === instance.id ? { ...v, lastOnline: Date.now() } : v);
        saveInstances(saved);
      } catch { /* A storage failure must not interrupt a live connection. */ }
      setData(value); setError(""); setUpdated(new Date().toLocaleTimeString()); setRevision(v => v + 1);
    }).catch(error => { if (current === generation.current) setError(errorText(error)); });
  }, [instance]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    refresh();
    return () => { ++generation.current; abort.current?.abort(); openAbort.current?.abort(); if (timer.current) clearTimeout(timer.current); };
  }, [refresh]);
  const live = useLive(instance, "/events", frame => {
    if (["hello", "resync", "task_status", "file_changed", "session_changed"].includes(frame.type)) {
      if (!timer.current) timer.current = setTimeout(() => { timer.current = null; refresh(); }, 100);
    }
  }, setStatus);

  const open = (target: OpenTarget, label: string) => {
    openAbort.current?.abort();
    const controller = new AbortController();
    openAbort.current = controller;
    setOpening(label); setOpenError(""); setOpenProgress(null);
    openSession(instance, target, controller.signal, progress => { if (openAbort.current === controller && !controller.signal.aborted) setOpenProgress(progress); }).then(id => {
      if (openAbort.current !== controller || controller.signal.aborted) return;
      known.current = placeholder(id, label);
      refresh();
      onSelect(id);
    }).catch(error => {
      if (openAbort.current !== controller || controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setOpenError(errorText(error instanceof ApiError ? error : new ApiError("open_failed")));
    }).finally(() => { if (openAbort.current === controller) { openAbort.current = null; setOpening(null); setOpenProgress(null); } });
  };
  const cancelOpen = () => {
    const id = openProgress?.request_id;
    const controller = openAbort.current;
    if (!id || !controller) return;
    // Await the server's cancellation before dropping our polling owner. A
    // failed cancellation remains actionable instead of claiming it stopped.
    void request(instance, `/open-requests/${encodeURIComponent(id)}/cancel`, {}).then(() => {
      if (openAbort.current !== controller) return;
      controller.abort(); openAbort.current = null; setOpening(null); setOpenProgress(null);
    }).catch(error => { if (openAbort.current === controller) setOpenError(errorText(error)); });
  };

  const listed = sessionId ? data.sessions.find(v => v.id === sessionId) : undefined;
  if (listed) known.current = listed;
  const selected = sessionId ? listed ?? (known.current?.id === sessionId ? known.current : placeholder(sessionId, sessionId)) : null;
  const canOpen = !!data.capabilities?.open_sessions;
  const canDesktopControl = !!data.capabilities?.desktop_control;
  return <>
    <div className="breadcrumb"><button data-testid="mobile-instances-back" onClick={onBack}>‹ 实例</button><span>{instance.label}</span><span className="connection" data-testid="mobile-connection">{status}</span></div>
    {live.canRetry && <button data-testid="mobile-events-retry" onClick={() => { live.retry(); refresh(); }}>重新连接事件流</button>}
    {error && <div className="card error" role="alert" data-testid="mobile-instance-error"><p>{error}</p><button data-testid="mobile-retry" onClick={refresh}>重试</button></div>}
    {desktop ? <>
      <button className="back" data-testid="mobile-sessions-back" onClick={onCloseDesktop ?? onCloseSession}>‹ 会话列表</button>
      <DesktopView key={instance.id} instance={instance} initialScreenEnabled={!!data.capabilities?.screen_capture} />
    </> : selected ? <>
      <button className="back" data-testid="mobile-sessions-back" onClick={onCloseSession}>‹ 会话列表</button>
      {selected.kind === "terminal" ? <TerminalView key={selected.id} instance={instance} session={selected} onBack={onCloseSession} /> : <TaskView key={selected.id} instance={instance} session={selected} revision={revision} stale={status !== "已连接" || !!error} />}
    </> : <>
      <div className="page-title"><p className="eyebrow">INSTANCE OVERVIEW</p><h1>远程执行，一目了然。</h1><p className="muted">终端留在实例端持续运行。</p></div>
      <div className="stats"><div><strong>{terminalSessions.filter(s => s.status === "running").length}</strong><span>正在运行</span></div><div><strong>{terminalSessions.filter(s => s.status === "awaiting_confirmation").length}</strong><span>等待确认</span></div><div><strong>{terminalSessions.length}</strong><span>全部会话</span></div></div>
      {(opening || openError) && <div className="card open-status" role="status" data-testid="mobile-open-status">
        {opening ? <><p>正在连接“{opening}”…{openProgress?.auth ? "请填写下方认证信息。" : "如需认证，将在此处提示。"}</p><button disabled={!openProgress?.request_id} onClick={cancelOpen}>取消连接</button></> : <p className="error">{openError}</p>}
        {opening && openError && <p className="error" role="alert">{openError}</p>}
      </div>}
      {opening && openProgress?.auth && <ConnectionAuthForm key={openProgress.auth.id} instance={instance} requestId={openProgress.request_id} challenge={openProgress.auth} onCancel={cancelOpen} />}
      <div className="section-heading"><h2>终端会话</h2><div className="heading-actions">
        {canDesktopControl && onOpenDesktop && <button data-testid="mobile-open-desktop" onClick={onOpenDesktop}>🖥 桌面与浏览器</button>}
        {canOpen && <button className="primary" data-testid="mobile-open-local" disabled={!!opening} onClick={() => open({ kind: "local" }, "本地终端")}>＋ 本地终端</button>}
        <button data-testid="mobile-refresh" onClick={refresh}>刷新</button>
      </div></div>
      <SessionResults sessions={terminalSessions} searchText={terminalSearchText} listClassName="session-list" listTestId="mobile-sessions" testIdPrefix="mobile-sessions" searchLabel="搜索终端会话" placeholder="搜索名称或摘要" empty={<div className="card empty" data-testid="mobile-empty-sessions"><span>⌁</span><h3>暂时没有运行中的终端</h3><p className="muted">{canOpen ? "点“＋ 本地终端”或在下方打开已保存会话。" : "在桌面打开终端。headless 模式不会新建终端。"}</p></div>} renderItem={session => <button data-testid="mobile-session" data-session-kind={session.kind} className="session-card" key={session.id} onClick={() => onSelect(session.id)}>
        <span className={`session-icon ${session.kind}`}>{">_"}</span><span className="session-copy"><strong>{session.title}</strong><small>{session.summary || "展开日志 · 终端输出与输入"}</small></span><span className="badge">{statusText(session.status)}</span><span aria-hidden>›</span>
      </button>} />
      <SavedSessionsPanel sessions={data.saved_sessions} canOpen={canOpen} opening={!!opening} onOpen={session => open({ kind: "saved", saved_session_id: session.id }, session.name)} />
    </>}
    <p className="footer" data-testid="mobile-sessions-updated">上次更新 {updated || "—"}{(error || status !== "已连接") && updated ? " · 可能已过期" : ""} · {instance.endpoint}</p>
  </>;
}
