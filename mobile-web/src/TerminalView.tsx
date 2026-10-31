import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ApiError, encoded, errorText, type Instance, type Session } from "./api";
import { useLive } from "./live";
const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
export function TerminalView({ instance, session }: { instance: Instance; session: Session }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [connection, setConnection] = useState("");
  const [ownerConnection, setOwnerConnection] = useState("");
  const [holder, setHolder] = useState("none");
  const [status, setStatus] = useState("连接中");
  const [notice, setNotice] = useState("");
  const [exited, setExited] = useState(session.status === "exited");
  const [paste, setPaste] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const controlling = holder === `mobile:${instance.deviceId}` && ownerConnection === connection && status === "已连接" && !exited;
  const controlRef = useRef(false); controlRef.current = controlling;
  const send = useLive(instance, `/terminals/${encoded(session.id)}/stream`, frame => {
    if (frame.type === "hello") setConnection(String(frame.connection_id || ""));
    else if (frame.type === "output" && typeof frame.data_b64 === "string") {
      terminal.current?.write(Uint8Array.from(atob(frame.data_b64), c => c.charCodeAt(0)));
    } else if (frame.type === "replay" && Array.isArray(frame.lines)) {
      terminal.current?.reset(); terminal.current?.write(frame.lines.join("\r\n"));
      if (frame.gap) setNotice("部分输出已超出回放范围，已显示最近输出。");
    } else if (frame.type === "control" && typeof frame.holder === "string") { setHolder(frame.holder); setOwnerConnection(String(frame.connection_id || "")); }
    else if (frame.type === "control-lost") { setHolder("none"); setNotice("桌面已抢回输入控制，当前为只读。"); }
    else if (frame.type === "exit") { setExited(true); setHolder("none"); }
    else if (frame.type === "error") setNotice(errorText(new ApiError(String(frame.code))));
  }, value => { setStatus(value); if (value !== "已连接") setHolder("none"); });
  const sendRef = useRef(send); sendRef.current = send;
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({ fontSize: 13, cursorBlink: false, scrollback: 1000, screenReaderMode: true, theme: { background: "#09121f", foreground: "#dce8f5" } });
    const fitter = new FitAddon(); term.loadAddon(fitter); term.open(host.current);
    terminal.current = term; fit.current = fitter;
    fitter.fit();
    const input = term.onData(data => { if (controlRef.current) sendRef.current({ type: "input", data_b64: encode(data) }); });
    const observer = new ResizeObserver(() => fitter.fit()); observer.observe(host.current);
    return () => { observer.disconnect(); input.dispose(); term.dispose(); terminal.current = null; fit.current = null; };
  }, []);
  const input = (text: string) => {
    if (!controlling) return;
    if (!send({ type: "input", data_b64: encode(text) })) setNotice("连接已断开，输入未发送。");
  };
  return <section className="card terminal-card" data-testid="mobile-terminal">
    <div className="section-heading"><div><p className="eyebrow">LIVE TERMINAL</p><h2>终端输出</h2></div><span className="badge" data-testid="mobile-terminal-status">{exited ? "已退出" : controlling ? "控制中" : "只读"} · {status}</span></div>
    <p className="note">回放最近 1000 行。接管后输入会直接发往远程终端，可能打断正在执行的命令。</p>
    <div ref={host} className="terminal" data-testid="mobile-terminal-screen" />
    <div className="actions"><button className="primary" data-testid="mobile-take-control" disabled={exited || status !== "已连接"} onClick={() => { setNotice(""); send({ type: controlling ? "release-control" : "take-control" }); }}>{controlling ? "释放输入" : "接管输入"}</button>
      <button data-testid="mobile-resize" disabled={!controlling} onClick={() => { fit.current?.fit(); if (terminal.current) send({ type: "resize", cols: terminal.current.cols, rows: terminal.current.rows }); }}>适配尺寸</button>
    </div>
    <div className="keybar" aria-label="终端常用键">
      {[["Tab", "\t"], ["Esc", "\x1b"], ["Ctrl-C", "\x03"], ["Ctrl-L", "\x0c"], ["↑", "\x1b[A"], ["↓", "\x1b[B"]].map(([label, key]) => <button key={label} disabled={!controlling} onClick={() => input(key)}>{label}</button>)}
      <button data-testid="mobile-paste" disabled={!controlling} onClick={() => setPasteOpen(v => !v)}>粘贴 / 历史</button>
    </div>
    {pasteOpen && <div><label>待发送内容<textarea data-testid="mobile-terminal-input" disabled={!controlling} value={paste} onChange={e => setPaste(e.target.value)} maxLength={8192} /></label>
      <div className="actions"><button disabled={!controlling || !paste} data-testid="mobile-terminal-send" onClick={() => { input(paste); setHistory(h => [paste, ...h.filter(v => v !== paste)].slice(0,10)); setPaste(""); }}>发送到终端</button>
      {window.isSecureContext && <button disabled={!controlling} onClick={() => navigator.clipboard.readText().then(setPaste).catch(() => setNotice("无法读取剪贴板，请使用系统粘贴。"))}>读取剪贴板</button>}</div>
      {history.map((value, i) => <button key={i} className="history" onClick={() => setPaste(value)}>{value.slice(0,80)}</button>)}</div>}
    {notice && <p role="status" data-testid="mobile-terminal-notice">{notice}</p>}
    <small className="muted">输入通道：PTY · {new Date().toLocaleTimeString()}</small>
  </section>;
}
