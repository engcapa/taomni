import { useEffect, useMemo, useState } from "react";
import { loadInstances, saveInstances, type Instance } from "./api";
import { InstanceView } from "./InstanceView";
import { PairForm } from "./PairForm";
import { useRoute } from "./route";

/** The instance a `#/session/<id>` link belongs to: the one serving this page, or the only one. */
function linkedInstance(instances: Instance[]): Instance | undefined {
  return instances.find(v => v.endpoint === location.origin) ?? (instances.length === 1 ? instances[0] : undefined);
}

export function App() {
  const [instances, setInstances] = useState(loadInstances);
  const [storageError, setStorageError] = useState("");
  const [offline, setOffline] = useState(() => !navigator.onLine);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const { route, navigate, back } = useRoute();
  const activeId = route.view === "instance" ? route.instanceId : null;
  const instance = useMemo(() => instances.find(v => v.id === activeId), [instances, activeId]);
  const pendingLink = route.view === "link" || route.view === "pair" ? route.sessionId ?? null : null;
  useEffect(() => {
    if (!pendingLink || route.view !== "link") return;
    const match = linkedInstance(instances);
    if (match) navigate({ view: "instance", instanceId: match.id, sessionId: pendingLink }, "replace");
  }, [pendingLink, route.view, instances, navigate]);
  const persist = (values: Instance[]) => {
    try { saveInstances(values); setInstances(values); setStorageError(""); }
    catch { setStorageError("浏览器无法保存实例，请允许本地存储后重试。"); }
  };
  const openInstance = (id: string) => navigate({ view: "instance", instanceId: id, ...(pendingLink ? { sessionId: pendingLink } : {}) }, pendingLink ? "replace" : "push");
  return <div className="app" data-testid="mobile-app">
    <header><a className="brand" href="#/" onClick={e => { e.preventDefault(); navigate({ view: "instances" }); }}><span className="brand-mark">›_</span><strong>taomni<span>remote</span></strong></a><span className="header-label">你的远程工作台</span></header>
    <main>
      {!window.isSecureContext && <p className="security-note" data-testid="mobile-insecure-note">当前为 HTTP 连接：扫码、剪贴板读取和 PWA 安装不可用。请手动输入配对码，或使用 HTTPS。</p>}
      {offline && <p role="status" className="security-note" data-testid="mobile-offline-note">当前离线，仅显示本机保存的实例与已接收数据；实时状态可能已过期，恢复网络后重新连接。</p>}
      {storageError && <p role="alert">{storageError}</p>}
      {route.view === "pair" ? <PairForm onCancel={() => back({ view: "instances" })} onPair={value => { persist([...instances.filter(v => v.id !== value.id), value]); navigate({ view: "instance", instanceId: value.id, ...(pendingLink ? { sessionId: pendingLink } : {}) }, "replace"); }} />
        : instance && route.view === "instance" ? <InstanceView
          key={instance.id}
          instance={instance}
          sessionId={route.sessionId}
          onSelect={sessionId => navigate({ view: "instance", instanceId: instance.id, sessionId }, route.sessionId ? "replace" : "push")}
          onCloseSession={() => back({ view: "instance", instanceId: instance.id })}
          onBack={() => { setInstances(loadInstances()); back({ view: "instances" }); }}
        /> : <>
          <div className="page-title"><p className="eyebrow">YOUR INSTANCES</p><h1>随时掌握执行进展。</h1><p className="muted">连接家中、公司或云上的 Taomni 实例。</p></div>
          {pendingLink && <p className="security-note" data-testid="mobile-link-pending">{instances.length ? `选择要打开会话 ${pendingLink} 的实例。` : `先配对实例，再打开会话 ${pendingLink}。`}</p>}
          {route.view === "instance" && !instance && <p className="security-note" data-testid="mobile-instance-missing">该实例未在此浏览器配对或已被移除。</p>}
          <div className="section-heading"><h2>我的实例 <span className="count">{instances.length}</span></h2><button className="primary" data-testid="mobile-add-instance" onClick={() => navigate({ view: "pair", ...(pendingLink ? { sessionId: pendingLink } : {}) })}>＋ 添加实例</button></div>
          {!instances.length && <section className="card empty" data-testid="mobile-empty-instances"><span>⌁</span><h3>连接你的第一个实例</h3><p className="muted">在桌面设置开启移动服务，再输入实例地址与一次性配对码。</p><button data-testid="mobile-first-instance" onClick={() => navigate({ view: "pair", ...(pendingLink ? { sessionId: pendingLink } : {}) })}>添加实例 →</button></section>}
          <div className="instances">{instances.map(value => <article className="card instance-card" key={value.id}>
            <button data-testid="mobile-instance-open" onClick={() => openInstance(value.id)}><span className="instance-icon">⌘</span><h3>{value.label}</h3><p>{value.endpoint}</p><small data-testid="mobile-instance-availability">{offline ? "本机离线" : "当前连通性未检查"} · 上次在线 {value.lastOnline ? new Date(value.lastOnline).toLocaleString() : "尚未连接"}</small><span className="open-link">查看会话 →</span></button>
            <button className="remove" data-testid="mobile-instance-remove" onClick={() => persist(instances.filter(v => v.id !== value.id))}>从本机移除</button>
          </article>)}</div>
          <p className="note">凭据保存在此浏览器。需要吊销设备时，请在对应实例的“移动服务”设置中操作。</p>
        </>}
    </main>
    <footer>TAOMNI REMOTE <span>执行在远端，掌控在手中。</span></footer>
  </div>;
}
