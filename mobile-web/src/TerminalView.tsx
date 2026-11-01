import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ApiError, encoded, errorText, type Instance, type Session } from "./api";
import { useLive, type Frame } from "./live";
import { TerminalComposer } from "./TerminalComposer";
import { TerminalKeybar } from "./TerminalKeybar";
import { FONT_MAX, FONT_MIN, MONO_FONT, clampFontSize, loadFontSize, loadFullscreen, loadKeysOpen, pinTerminal, saveFontSize, saveFullscreen, saveKeysOpen } from "./terminalDisplay";
import { NO_MODIFIERS, applyTypedModifiers, encodeBase64, pastePayload, type Modifiers } from "./terminalKeys";
import { attachTouchGestures } from "./terminalTouch";

const READ_ONLY_HINT = "当前为只读，先点“接管输入”再输入。";
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

export function TerminalView({ instance, session, onBack }: { instance: Instance; session: Session; onBack?: () => void }) {
  const card = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const relayout = useRef<() => void>(() => {});
  const draftKeyHandler = useRef<((key: string) => boolean) | null>(null);
  const [connection, setConnection] = useState("");
  const [ownerConnection, setOwnerConnection] = useState("");
  const [desktopActivity, setDesktopActivity] = useState<number | null>(null);
  const [holder, setHolder] = useState("none");
  const [status, setStatus] = useState("连接中");
  const [notice, setNotice] = useState("");
  const [exited, setExited] = useState(session.status === "exited");
  const [panelOpen, setPanelOpen] = useState(false);
  const [modifiers, setModifiers] = useState<Modifiers>(NO_MODIFIERS);
  const [fontSize, setFontSize] = useState(loadFontSize);
  const [fullscreen, setFullscreen] = useState(loadFullscreen);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [keysOpen, setKeysOpen] = useState(loadKeysOpen);
  const controlling = holder === `mobile:${instance.deviceId}` && ownerConnection === connection && status === "已连接" && !exited;
  const controlRef = useRef(false); controlRef.current = controlling;
  const modifiersRef = useRef(modifiers); modifiersRef.current = modifiers;
  const fullscreenRef = useRef(fullscreen); fullscreenRef.current = fullscreen;
  const send = useLive(instance, `/terminals/${encoded(session.id)}/stream`, (frame: Frame) => {
    if (frame.type === "hello") setConnection(String(frame.connection_id || ""));
    else if (frame.type === "output" && typeof frame.data_b64 === "string") {
      terminal.current?.write(Uint8Array.from(atob(frame.data_b64), c => c.charCodeAt(0)));
    } else if (frame.type === "replay" && Array.isArray(frame.lines)) {
      terminal.current?.reset(); terminal.current?.write(frame.lines.join("\r\n"));
      if (frame.gap) setNotice("部分输出已超出回放范围，已显示最近输出。");
    } else if (frame.type === "control" && typeof frame.holder === "string") {
      setHolder(frame.holder);
      setDesktopActivity(typeof frame.desktop_last_activity_at === "number" ? frame.desktop_last_activity_at : null);
      setOwnerConnection(String(frame.connection_id || ""));
    } else if (frame.type === "control-lost") { setHolder("none"); setNotice("桌面已抢回输入控制，当前为只读。"); }
    else if (frame.type === "exit") { setExited(true); setHolder("none"); }
    else if (frame.type === "error") setNotice(errorText(new ApiError(String(frame.code))));
  }, value => { setStatus(value); if (value !== "已连接") setHolder("none"); });
  const sendRef = useRef(send); sendRef.current = send;
  useEffect(() => {
    const element = host.current;
    const box = card.current;
    if (!element || !box) return;
    const term = new Terminal({ fontSize, fontFamily: MONO_FONT, cursorBlink: false, scrollback: 1000, screenReaderMode: true, theme: { background: "#09121f", foreground: "#dce8f5" } });
    const fitter = new FitAddon(); term.loadAddon(fitter); term.open(element);
    terminal.current = term; fit.current = fitter;
    const layout = () => { pinTerminal(box, element, fullscreenRef.current); fitter.fit(); };
    relayout.current = layout;
    layout();
    const input = term.onData(data => {
      // xterm answers terminal queries through onData too; those start with ESC
      // and must neither raise the read-only hint nor consume a modifier.
      const typed = !data.startsWith("\x1b");
      if (!controlRef.current) { if (typed) setNotice(READ_ONLY_HINT); return; }
      const armed = modifiersRef.current;
      let payload = data;
      if (typed && (armed.ctrl || armed.alt)) {
        payload = applyTypedModifiers(data, armed);
        modifiersRef.current = NO_MODIFIERS; setModifiers(NO_MODIFIERS);
      }
      sendRef.current({ type: "input", data_b64: encodeBase64(payload) });
    });
    // While this phone holds input the PTY follows its geometry: rotating, full
    // screen, the soft keyboard and font changes refit xterm, and the program
    // gets SIGWINCH for the new size instead of drawing for a stale one.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const resized = term.onResize(() => {
      if (!controlRef.current) return;
      clearTimeout(pending);
      pending = setTimeout(() => { if (controlRef.current) sendRef.current({ type: "resize", cols: term.cols, rows: term.rows }); }, 150);
    });
    const position = () => { const buffer = term.buffer.active; setScrolledUp(buffer.viewportY < buffer.baseY); };
    const scrolled = term.onScroll(position);
    const parsed = term.onWriteParsed(position);
    let scrollRemainder = 0;
    const detachTouch = attachTouchGestures(element, {
      screen: () => element.querySelector<HTMLElement>(".xterm-screen"),
      onPinch: step => setFontSize(v => clampFontSize(v + step)),
      onScroll: pixels => {
        if (term.buffer.active.type !== "normal" || term.modes.mouseTrackingMode !== "none") { scrollRemainder = 0; return false; }
        const cellHeight = element.clientHeight / Math.max(1, term.rows);
        scrollRemainder += pixels / Math.max(1, cellHeight);
        const lines = Math.trunc(scrollRemainder);
        scrollRemainder -= lines;
        if (lines) term.scrollLines(lines);
        return true;
      },
    });
    const observer = new ResizeObserver(() => fitter.fit()); observer.observe(element);
    window.addEventListener("resize", layout);
    window.addEventListener("orientationchange", layout);
    window.visualViewport?.addEventListener("resize", layout);
    window.visualViewport?.addEventListener("scroll", layout);
    return () => {
      clearTimeout(pending);
      detachTouch();
      observer.disconnect();
      window.removeEventListener("resize", layout);
      window.removeEventListener("orientationchange", layout);
      window.visualViewport?.removeEventListener("resize", layout);
      window.visualViewport?.removeEventListener("scroll", layout);
      input.dispose(); resized.dispose(); scrolled.dispose(); parsed.dispose(); term.dispose();
      terminal.current = null; fit.current = null; relayout.current = () => {};
    };
    // The terminal is created once; later font size changes are applied below.
  }, []);
  useEffect(() => {
    const term = terminal.current;
    if (term && term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    saveFontSize(fontSize);
    relayout.current();
  }, [fontSize]);
  useEffect(() => saveKeysOpen(keysOpen), [keysOpen]);
  useLayoutEffect(() => {
    saveFullscreen(fullscreen);
    document.documentElement.classList.toggle("terminal-fullscreen", fullscreen);
    return () => document.documentElement.classList.remove("terminal-fullscreen");
  }, [fullscreen]);
  // Full screen gives the box whatever the other rows leave, and those rows
  // (notice, paste panel, holder note) change with state: re-pin every render.
  useLayoutEffect(() => { relayout.current(); });
  const input = (text: string) => {
    if (!controlling) return false;
    if (send({ type: "input", data_b64: encodeBase64(text) })) return true;
    setNotice("连接已断开，输入未发送。");
    return false;
  };
  const sendText = (text: string, enter: boolean) => {
    const bracketed = terminal.current?.modes.bracketedPasteMode ?? false;
    const ok = input((text ? pastePayload(text, bracketed) : "") + (enter ? "\r" : ""));
    if (ok) terminal.current?.scrollToBottom();
    return ok;
  };
  const toggleKeyboard = () => {
    const term = terminal.current;
    if (!term) return;
    if (term.textarea && document.activeElement === term.textarea) term.blur(); else term.focus();
  };
  const command = (frame: Frame) => { if (!send(frame)) setNotice("连接已断开，操作未发送。"); };
  // Full-screen TUIs (Codex, Claude Code) paint at the PTY geometry, so a read-only
  // phone view of a desktop-sized session re-wraps every absolute position. The PTY
  // only accepts a size from the write holder, so adopt the phone width as soon as
  // control is taken: the app gets SIGWINCH and redraws for this screen.
  const adopted = useRef(false);
  useEffect(() => {
    if (!controlling) { adopted.current = false; setModifiers(NO_MODIFIERS); return; }
    if (adopted.current) return;
    adopted.current = true;
    const timer = setTimeout(() => {
      fit.current?.fit();
      if (terminal.current) sendRef.current({ type: "resize", cols: terminal.current.cols, rows: terminal.current.rows });
    }, 60);
    return () => clearTimeout(timer);
  }, [controlling]);
  const badge = exited ? "已退出" : controlling ? "控制中" : holder !== "none" ? "只读 · 他处已接管" : "只读";
  return <section ref={card} className={`card terminal-card${fullscreen ? " fullscreen" : ""}`} data-testid="mobile-terminal">
    <div className="section-heading">
      {fullscreen && onBack && <button className="terminal-back" data-testid="mobile-terminal-back" aria-label="返回会话列表" onClick={onBack}>‹</button>}
      <div className="terminal-title"><p className="eyebrow">LIVE TERMINAL</p><h2>{session.title || "终端输出"}</h2></div>
      <div className="terminal-tools">
        <span className="badge" data-testid="mobile-terminal-status">{badge} · {status}</span>
        <button data-testid="mobile-terminal-font-down" aria-label="缩小字号" title="缩小字号" disabled={fontSize <= FONT_MIN} onMouseDown={keepFocus} onClick={() => setFontSize(v => clampFontSize(v - 1))}>A−</button>
        <button data-testid="mobile-terminal-font-up" aria-label="放大字号" title="放大字号" disabled={fontSize >= FONT_MAX} onMouseDown={keepFocus} onClick={() => setFontSize(v => clampFontSize(v + 1))}>A+</button>
        <button data-testid="mobile-terminal-keys" aria-pressed={keysOpen} aria-label={keysOpen ? "收起按键" : "显示按键"} onMouseDown={keepFocus} onClick={() => setKeysOpen(v => !v)}>按键</button>
        <button data-testid="mobile-terminal-fullscreen" aria-pressed={fullscreen} aria-label={fullscreen ? "退出全屏" : "全屏"} onMouseDown={keepFocus} onClick={() => setFullscreen(v => !v)}>{fullscreen ? "退出" : "全屏"}</button>
      </div>
    </div>
    <p className="note terminal-intro">在终端上下拖动可滚动历史，双指缩放调整字号。只读视图沿用桌面终端尺寸，全屏程序在窄屏会被折行；接管输入后自动按手机宽度重排，桌面一旦输入即恢复。</p>
    <div className="terminal-frame">
      <div ref={host} className="terminal" data-testid="mobile-terminal-screen" />
      {scrolledUp && <button className="scroll-latest" data-testid="mobile-terminal-latest" onMouseDown={keepFocus} onClick={() => terminal.current?.scrollToBottom()}>↓ 最新</button>}
    </div>
    {notice && <p role="status" className="terminal-notice" data-testid="mobile-terminal-notice">{notice}</p>}
    <TerminalComposer disabled={!controlling} panelOpen={panelOpen} onSend={sendText} onNotice={setNotice} keyHandler={draftKeyHandler} />
    {keysOpen && <TerminalKeybar disabled={!controlling} modifiers={modifiers} onModifiers={setModifiers} onSend={data => { if (!draftKeyHandler.current?.(data)) input(data); }} appCursor={() => terminal.current?.modes.applicationCursorKeysMode ?? false} />}
    <div className="actions terminal-actions">
      <button className="primary" data-testid="mobile-take-control" disabled={exited || status !== "已连接"} onClick={() => { setNotice(""); command({ type: controlling ? "release-control" : "take-control" }); }}>{controlling ? "释放输入" : "接管输入"}</button>
      <button data-testid="mobile-terminal-keyboard" disabled={!controlling} onMouseDown={keepFocus} onClick={toggleKeyboard}>键盘</button>
      <button data-testid="mobile-paste" aria-pressed={panelOpen} disabled={!controlling} onClick={() => setPanelOpen(v => !v)}>多行 / 历史</button>
      <button data-testid="mobile-resize" disabled={!controlling} onClick={() => { fit.current?.fit(); if (terminal.current) command({ type: "resize", cols: terminal.current.cols, rows: terminal.current.rows }); }}>适配尺寸</button>
    </div>
    {desktopActivity && <p className="note terminal-meta">桌面最近活动：{new Date(desktopActivity * 1000).toLocaleTimeString()}；接管后桌面随时可抢回。</p>}
    <small className="muted terminal-meta">输入通道：PTY · 字号 {fontSize}</small>
  </section>;
}
