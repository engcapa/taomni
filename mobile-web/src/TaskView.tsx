import { useCallback, useEffect, useState } from "react";
import { encoded, errorText, request, statusText, type Changes, type Detail, type FileContent, type Instance, type Session } from "./api";

export function TaskView({ instance, session, revision }: { instance: Instance; session: Session; revision: number }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changes, setChanges] = useState<Changes | null>(null);
  const [changesError, setChangesError] = useState("");
  const [content, setContent] = useState<FileContent | null>(null);
  const [updated, setUpdated] = useState("");
  const [fileChoice, setFileChoice] = useState<{ path: string; diff: boolean } | null>(null);
  const path = `/sessions/${encoded(session.id)}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await request<Detail>(instance, path, undefined, signal);
    if (!signal?.aborted) { setDetail(value); setUpdated(new Date().toLocaleTimeString()); }
  }, [instance, path]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(e => { if (!abort.signal.aborted) setError(errorText(e)); });
    void request<Changes>(instance, `/tasks/${encoded(session.id)}/changes`, undefined, abort.signal).then(v => { if (!abort.signal.aborted) { setChanges(v); setChangesError(""); } }).catch(e => { if (!abort.signal.aborted) setChangesError(errorText(e)); });
    return () => abort.abort();
  }, [load, instance, session.id, revision]);
  useEffect(() => {
    if (!fileChoice) return;
    const abort = new AbortController();
    const base = `/tasks/${encoded(session.id)}`;
    const route = fileChoice.diff ? `${base}/changes/${encoded(fileChoice.path)}/diff` : `${base}/files?path=${encoded(fileChoice.path)}`;
    setContent(null);
    void request<FileContent>(instance, route, undefined, abort.signal).then(v => { if (!abort.signal.aborted) setContent(v); }).catch(e => { if (!abort.signal.aborted) setError(errorText(e)); });
    return () => abort.abort();
  }, [instance, session.id, fileChoice, revision]);
  const action = async (route: string, body: unknown, done?: () => void) => {
    setBusy(true); setError("");
    try { await request(instance, route, body); done?.(); await load(); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  const running = detail?.status === "running" || detail?.status === "awaiting_confirmation";
  return <section className="card" data-testid="mobile-task">
    <div className="section-heading"><div><p className="eyebrow">AGENT TASK</p><h2>{session.title}</h2></div><span className="badge" data-testid="mobile-task-status">{statusText(detail?.status || session.status)}</span></div>
    <p>{detail?.summary || session.summary || "任务执行留在实例端，关闭页面不会停止任务。"}</p>
    <button data-testid="mobile-task-stop" disabled={busy || !running} onClick={() => void action(`${path}/stop`, {})}>停止当前轮次</button>
    {detail?.confirmations?.map(c => <div className="confirmation" key={c.id}><p>待确认：{c.tool}</p>{c.supported ? <div className="actions"><button disabled={busy} onClick={() => void action(`/tasks/${encoded(session.id)}/confirmations/${encoded(c.id)}`, { decision: "approve" })}>同意</button><button disabled={busy} onClick={() => void action(`/tasks/${encoded(session.id)}/confirmations/${encoded(c.id)}`, { decision: "reject" })}>拒绝</button></div> : <p>需在桌面确认</p>}</div>)}
    <form onSubmit={e => { e.preventDefault(); const message = text; void action(`${path}/message`, { text: message }, () => { setText(""); setHistory(h => [message, ...h.filter(v => v !== message)].slice(0,10)); }); }}>
      <label>给 Agent 的后续指令<textarea data-testid="mobile-agent-input" value={text} onChange={e => setText(e.target.value)} placeholder="下一步需要做什么？" maxLength={32768} disabled={busy} /></label>
      <p className="note">由手机发起，未带桌面上下文。此输入不会发送到 PTY。headless 下桌面工具不可用。</p>
      <div className="actions"><button className="primary" data-testid="mobile-agent-send" disabled={busy || !!running || !text.trim()}>发送指令</button><button type="button" onClick={() => setText("请汇报当前进展、阻塞点和下一步。")}>汇报进展</button></div>
      {history.map((value, i) => <button type="button" className="history" key={i} onClick={() => setText(value)}>{value.slice(0,80)}</button>)}
    </form>
    {error && <p role="alert" data-testid="mobile-task-error">{error}</p>}
    <div className="section-heading"><h3>文件改动 · 只读</h3><button onClick={() => { setChangesError(""); void request<Changes>(instance, `/tasks/${encoded(session.id)}/changes`).then(setChanges).catch(e => setChangesError(errorText(e))); }}>刷新</button></div>
    {changesError && <p className="note" data-testid="mobile-changes-error">{changesError}</p>}
    {changes?.changes.length === 0 && <p className="muted">暂无文件改动</p>}
    {changes?.changes.map(change => <div className="change" key={change.path}><span>{change.change_kind}</span><button data-testid="mobile-file-open" onClick={() => { setError(""); setFileChoice({ path: change.path, diff: false }); }}>{change.path}</button><button data-testid="mobile-diff-open" disabled={!change.diff_available} onClick={() => { setError(""); setFileChoice({ path: change.path, diff: true }); }}>diff</button></div>)}
    {changes?.truncated && <p>改动列表已截断。</p>}
    {fileChoice && <article className="file-view" data-testid="mobile-file-view"><div className="section-heading"><h3>{fileChoice.path} · {fileChoice.diff ? "diff" : "只读"}</h3><button onClick={() => { setFileChoice(null); setContent(null); }}>关闭</button></div>
      {content?.truncated && <p role="status">内容已截断（最大 256 KiB）。</p>}
      {content?.hunks?.map((hunk,i) => <details key={i} open={i === 0}><summary>{i === 0 ? "文件信息" : hunk.split("\n")[0]}</summary><pre>{hunk}</pre></details>)}
      {content?.content !== undefined && <pre data-testid="mobile-file-content">{content.content.split("\n").map((line,i) => <span className="code-line" key={i}><span className="line-number">{i+1}</span>{line}{"\n"}</span>)}</pre>}
      {!content && !error && <p>正在加载…</p>}
    </article>}
    <small className="muted">上次更新 {updated || "—"}</small>
  </section>;
}
