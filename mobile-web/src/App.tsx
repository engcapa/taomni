import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, loadInstances, request, saveInstances, statusText, type Instance, type Session, type SessionList } from "./api";
import { PairForm } from "./PairForm";
import { TerminalView } from "./TerminalView";
import { TaskView } from "./TaskView";
import { useLive } from "./live";

function InstanceView({ instance, onBack }: { instance: Instance; onBack: () => void }) {
  const [data, setData] = useState<SessionList>({ sessions: [], saved_sessions: [] });
  const [selected, setSelected] = useState<Session | null>(null);
  const [status, setStatus] = useState("连接中");
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState("");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    const current = ++generation.current;
    abort.current?.abort(); abort.current = new AbortController();
    void request<SessionList>(instance, "/sessions", undefined, abort.current.signal).then(value => {
      if (current !== generation.current) return;
      try {
        const saved = loadInstances().map(v => v.id === instance.id ? { ...v, lastOnline: Date.now() } : v);
        saveInstances(saved);
      } catch { /* A storage failure must not interrupt a live connection. */ }
      setData(value); setError(""); setUpdated(new Date().toLocaleTimeString()); setRevision(v => v+1);
    }).catch(error => { if (current === generation.current) setError(errorText(error)); });
  }, [instance]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    refresh();
    return () => { ++generation.current; abort.current?.abort(); if (timer.current) clearTimeout(timer.current); };
  }, [refresh]);
  useLive(instance, "/events", frame => {
    if (["hello", "resync", "task_status", "file_changed", "session_changed"].includes(frame.type)) {
      if (!timer.current) timer.current = setTimeout(() => { timer.current = null; refresh(); }, 100);
    }
  }, setStatus);
  return <>
    <div className="breadcrumb"><button data-testid="mobile-instances-back" onClick={onBack}>‹ 实例</button><span>{instance.label}</span><span className="connection" data-testid="mobile-connection">{status}</span></div>
    {error && <div className="card error" role="alert" data-testid="mobile-instance-error"><p>{error}</p><button data-testid="mobile-retry" onClick={refresh}>重试</button></div>}
    {selected ? <>
      <button className="back" data-testid="mobile-sessions-back" onClick={() => setSelected(null)}>‹ 会话列表</button>
      {selected.kind === "terminal" ? <TerminalView key={selected.id} instance={instance} session={selected} /> : <TaskView key={selected.id} instance={instance} session={data.sessions.find(v => v.id === selected.id) || selected} revision={revision} />}
    </> : <>
      <div className="page-title"><p className="eyebrow">INSTANCE OVERVIEW</p><h1>远程执行，一目了然。</h1><p className="muted">终端与 Agent 留在实例端持续运行。</p></div>
      <div className="stats"><div><strong>{data.sessions.filter(s => s.status === "running").length}</strong><span>正在运行</span></div><div><strong>{data.sessions.filter(s => s.status === "awaiting_confirmation").length}</strong><span>等待确认</span></div><div><strong>{data.sessions.length}</strong><span>全部会话</span></div></div>
      <div className="section-heading"><h2>终端与任务</h2><button data-testid="mobile-refresh" onClick={refresh}>刷新</button></div>
      <div className="session-list" data-testid="mobile-sessions">
        {data.sessions.map(session => <button data-testid="mobile-session" data-session-kind={session.kind} className="session-card" key={session.id} onClick={() => setSelected(session)}>
          <span className={`session-icon ${session.kind}`}>{session.kind === "terminal" ? ">_" : "✧"}</span><span className="session-copy"><strong>{session.title}</strong><small>{session.summary || (session.kind === "terminal" ? "展开日志 · 终端输出与输入" : "Agent 任务 · 指令与文件改动")}</small></span><span className="badge">{statusText(session.status)}</span><span aria-hidden>›</span>
        </button>)}
        {!data.sessions.length && <div className="card empty" data-testid="mobile-empty-sessions"><span>⌁</span><h3>暂时没有运行会话</h3><p className="muted">在桌面打开终端或创建 Agent 线程。headless 模式不会新建终端。</p></div>}
      </div>
      <section className="card"><p className="eyebrow">SAVED SESSIONS</p><h2>已保存会话 <span className="muted">· 只读</span></h2><p className="note">手机端不新建连接，仅展示名称、类型与分组。</p>
        {data.saved_sessions.map(session => <div className="saved-session" data-testid="mobile-saved-session" key={session.id}><strong>{session.name}</strong><span>{session.session_type} · {session.group_path || "未分组"}</span></div>)}
        {!data.saved_sessions.length && <p className="muted">没有已保存的终端类会话</p>}
      </section>
    </>}
    <p className="footer">上次更新 {updated || "—"} · {instance.endpoint}</p>
  </>;
}
export function App() {
  const [instances, setInstances] = useState(loadInstances);
  const [active, setActive] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [storageError, setStorageError] = useState("");
  const instance = useMemo(() => instances.find(v => v.id === active), [instances, active]);
  const persist = (values: Instance[]) => {
    try { saveInstances(values); setInstances(values); setStorageError(""); }
    catch { setStorageError("浏览器无法保存实例，请允许本地存储后重试。"); }
  };
  return <div className="app" data-testid="mobile-app">
    <header><a className="brand" href="/" onClick={e => { e.preventDefault(); setActive(null); setPairing(false); }}><span className="brand-mark">›_</span><strong>taomni<span>remote</span></strong></a><span className="header-label">你的远程工作台</span></header>
    <main>
      {!window.isSecureContext && <p className="security-note" data-testid="mobile-insecure-note">当前为 HTTP 连接：扫码、剪贴板读取和 PWA 安装不可用。请手动输入配对码，或使用 HTTPS。</p>}
      {storageError && <p role="alert">{storageError}</p>}
      {pairing ? <PairForm onCancel={() => setPairing(false)} onPair={value => { persist([...instances.filter(v => v.id !== value.id), value]); setActive(value.id); setPairing(false); }} /> : instance ? <InstanceView key={instance.id} instance={instance} onBack={() => { setInstances(loadInstances()); setActive(null); }} /> : <>
        <div className="page-title"><p className="eyebrow">YOUR INSTANCES</p><h1>随时掌握执行进展。</h1><p className="muted">连接家中、公司或云上的 Taomni 实例。</p></div>
        <div className="section-heading"><h2>我的实例 <span className="count">{instances.length}</span></h2><button className="primary" data-testid="mobile-add-instance" onClick={() => setPairing(true)}>＋ 添加实例</button></div>
        {!instances.length && <section className="card empty" data-testid="mobile-empty-instances"><span>⌁</span><h3>连接你的第一个实例</h3><p className="muted">在桌面设置开启移动服务，再输入实例地址与一次性配对码。</p><button data-testid="mobile-first-instance" onClick={() => setPairing(true)}>添加实例 →</button></section>}
        <div className="instances">{instances.map(value => <article className="card instance-card" key={value.id}>
          <button data-testid="mobile-instance-open" onClick={() => setActive(value.id)}><span className="instance-icon">⌘</span><h3>{value.label}</h3><p>{value.endpoint}</p><small>上次在线 {value.lastOnline ? new Date(value.lastOnline).toLocaleString() : "尚未连接"}</small><span className="open-link">查看会话 →</span></button>
          <button className="remove" data-testid="mobile-instance-remove" onClick={() => persist(instances.filter(v => v.id !== value.id))}>从本机移除</button>
        </article>)}</div>
        <p className="note">凭据保存在此浏览器。需要吊销设备时，请在对应实例的“移动服务”设置中操作。</p>
      </>}
    </main>
    <footer>TAOMNI REMOTE <span>执行在远端，掌控在手中。</span></footer>
  </div>;
}
