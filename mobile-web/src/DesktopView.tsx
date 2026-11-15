import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  encoded,
  errorText,
  request,
  type BrowserOpenResponse,
  type DesktopWindow,
  type DesktopWindowsResponse,
  type Instance,
  type ScreenCapture,
  type WindowInputResponse,
} from "./api";
import {
  isBrowserOpenResponse,
  isDesktopWindows,
  isScreenCapture,
  isWindowInputResponse,
} from "./apiContracts";

const QUICK_KEYS = [
  { id: "enter", label: "Enter" },
  { id: "tab", label: "Tab" },
  { id: "escape", label: "Esc" },
  { id: "backspace", label: "⌫" },
  { id: "f5", label: "F5" },
  { id: "ctrl-l", label: "Ctrl+L" },
  { id: "ctrl-c", label: "Ctrl+C" },
  { id: "ctrl-a", label: "Ctrl+A" },
  { id: "ctrl-enter", label: "Ctrl+Enter" },
] as const;

export function DesktopView({ instance, initialScreenEnabled = false }: {
  instance: Instance;
  initialScreenEnabled?: boolean;
}) {
  const [screen, setScreen] = useState<ScreenCapture | null>(null);
  const [screenEnabled, setScreenEnabled] = useState(initialScreenEnabled);
  const [screenLoading, setScreenLoading] = useState(false);
  const [screenDisabled, setScreenDisabled] = useState(false);
  const [screenError, setScreenError] = useState("");
  const [displayId, setDisplayId] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);

  const [windows, setWindows] = useState<DesktopWindow[]>([]);
  const [selectedWindowId, setSelectedWindowId] = useState("");
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [windowsError, setWindowsError] = useState("");

  const [browserUrl, setBrowserUrl] = useState("");
  const [browserOpening, setBrowserOpening] = useState(false);
  const [browserResult, setBrowserResult] = useState<BrowserOpenResponse | null>(null);
  const [browserError, setBrowserError] = useState("");

  const [windowText, setWindowText] = useState("");
  const [submitWithEnter, setSubmitWithEnter] = useState(true);
  const [sendingInput, setSendingInput] = useState(false);
  const [inputResult, setInputResult] = useState("");
  const [inputError, setInputError] = useState("");

  const screenGen = useRef(0);
  const screenAbort = useRef<AbortController | null>(null);
  const windowsGen = useRef(0);
  const windowsAbort = useRef<AbortController | null>(null);
  const displayIdRef = useRef(displayId);
  displayIdRef.current = displayId;

  const refreshScreen = useCallback(async (overrideDisplay?: string) => {
    const gen = ++screenGen.current;
    screenAbort.current?.abort();
    const controller = new AbortController();
    screenAbort.current = controller;
    setScreenLoading(true);
    const chosen = overrideDisplay ?? displayIdRef.current;
    const query = chosen ? `?display=${encoded(chosen)}` : "";
    try {
      const value = await request<ScreenCapture>(instance, `/desktop/screen${query}`, undefined, controller.signal);
      if (gen !== screenGen.current) return;
      if (!isScreenCapture(value)) throw new ApiError("invalid_api_response");
      setScreen(value);
      setScreenEnabled(true);
      setScreenDisabled(false);
      setScreenError("");
      if (!displayIdRef.current && value.display_id) setDisplayId(value.display_id);
    } catch (error) {
      if (gen !== screenGen.current || (error instanceof DOMException && error.name === "AbortError")) return;
      if (error instanceof ApiError && error.code === "screen_capture_disabled") {
        setScreen(null);
        setScreenEnabled(false);
        setScreenDisabled(true);
        setAutoRefresh(false);
        setScreenError("");
      } else {
        setScreenError(errorText(error));
      }
    } finally {
      if (gen === screenGen.current) setScreenLoading(false);
    }
  }, [instance]);

  const refreshWindows = useCallback(async (preferredWindowId?: string) => {
    const gen = ++windowsGen.current;
    windowsAbort.current?.abort();
    const controller = new AbortController();
    windowsAbort.current = controller;
    setWindowsLoading(true);
    try {
      const value = await request<DesktopWindowsResponse>(instance, "/desktop/windows", undefined, controller.signal);
      if (gen !== windowsGen.current) return;
      if (!isDesktopWindows(value)) throw new ApiError("invalid_api_response");
      setWindows(value.windows);
      setScreenEnabled(value.screen_capture_enabled);
      setWindowsError("");
      setSelectedWindowId(prev => {
        if (preferredWindowId && value.windows.some(item => item.id === preferredWindowId)) return preferredWindowId;
        if (prev && value.windows.some(item => item.id === prev)) return prev;
        return (value.windows.find(item => item.focused) ?? value.windows[0])?.id ?? "";
      });
    } catch (error) {
      if (gen !== windowsGen.current || (error instanceof DOMException && error.name === "AbortError")) return;
      setWindowsError(errorText(error));
    } finally {
      if (gen === windowsGen.current) setWindowsLoading(false);
    }
  }, [instance]);

  useEffect(() => {
    void refreshScreen();
    void refreshWindows();
    return () => {
      ++screenGen.current;
      ++windowsGen.current;
      screenAbort.current?.abort();
      windowsAbort.current?.abort();
    };
  }, [refreshScreen, refreshWindows]);

  useEffect(() => {
    if (!autoRefresh || screenDisabled) return;
    const timer = setInterval(() => {
      if (!screenLoading) void refreshScreen();
    }, 2000);
    return () => clearInterval(timer);
  }, [autoRefresh, screenDisabled, screenLoading, refreshScreen]);

  const openServerBrowser = async (event: React.FormEvent) => {
    event.preventDefault();
    const targetUrl = browserUrl.trim();
    if (!targetUrl) {
      setBrowserError(errorText(new ApiError("invalid_browser_url")));
      return;
    }
    setBrowserOpening(true);
    setBrowserError("");
    try {
      const value = await request<BrowserOpenResponse>(instance, "/desktop/browser", { url: targetUrl });
      if (!isBrowserOpenResponse(value)) throw new ApiError("invalid_api_response");
      setBrowserResult(value);
      setScreenEnabled(value.screen_capture_enabled);
      setSelectedWindowId(value.window_id);
      await refreshWindows(value.window_id);
      if (value.screen_capture_enabled) void refreshScreen();
      else setScreenDisabled(true);
    } catch (error) {
      setBrowserError(errorText(error));
    } finally {
      setBrowserOpening(false);
    }
  };

  const deliverWindowInput = async (payload: { text: string; key?: string; submit: boolean }, clearText = false) => {
    if (!selectedWindowId) {
      setInputError("请先选择目标窗口。");
      return;
    }
    setSendingInput(true);
    setInputError("");
    setInputResult("");
    try {
      const value = await request<WindowInputResponse>(
        instance,
        `/desktop/windows/${encoded(selectedWindowId)}/input`,
        payload,
      );
      if (!isWindowInputResponse(value)) throw new ApiError("invalid_api_response");
      if (clearText) setWindowText("");
      const desc = payload.key
        ? `已发送按键 ${payload.key}`
        : `已发送文本（${payload.text.length} 字符${payload.submit ? " + Enter" : ""}）`;
      setInputResult(`${desc} 到窗口“${value.title || value.window_id}”。`);
      if (screenEnabled) void refreshScreen();
    } catch (error) {
      setInputError(errorText(error));
    } finally {
      setSendingInput(false);
    }
  };

  const onSubmitWindowInput = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!windowText && !submitWithEnter) {
      setInputError(errorText(new ApiError("empty_window_input")));
      return;
    }
    await deliverWindowInput({ text: windowText, submit: submitWithEnter }, true);
  };

  const activeWindow = windows.find(item => item.id === selectedWindowId);
  const displays = screen?.displays ?? [];

  return <div data-testid="mobile-desktop-view">
    <div className="page-title">
      <p className="eyebrow">DESKTOP REMOTE</p>
      <h1>桌面屏幕与窗口控制</h1>
      <p className="muted">查看服务器当前桌面屏幕、在服务端打开浏览器页面，或向指定桌面窗口发送输入。</p>
    </div>

    <section className="card" data-testid="mobile-desktop-screen-card">
      <div className="section-heading">
        <h2>桌面屏幕</h2>
        <div className="heading-actions">
          {displays.length > 1 && <select
            aria-label="选择显示器"
            data-testid="mobile-desktop-display"
            value={displayId}
            onChange={e => { const next = e.target.value; setDisplayId(next); void refreshScreen(next); }}
          >
            {displays.map(d => <option key={d.id} value={d.id}>{d.name} ({d.width}×{d.height}){d.primary ? " · 主屏" : ""}</option>)}
          </select>}
          {screenEnabled && !screenDisabled && <button
            type="button"
            data-testid="mobile-desktop-auto-refresh"
            aria-pressed={autoRefresh}
            onClick={() => setAutoRefresh(v => !v)}
          >{autoRefresh ? "自动刷新: 开" : "自动刷新"}</button>}
          <button
            type="button"
            className="primary"
            data-testid="mobile-desktop-refresh"
            disabled={screenLoading}
            onClick={() => void refreshScreen()}
          >{screenLoading ? "刷新中…" : "刷新屏幕"}</button>
        </div>
      </div>

      {screenDisabled ? (
        <p className="security-note" data-testid="mobile-screen-disabled">
          当前未开启“允许在手机 Web 和飞书查看当前屏幕”。请在 Taomni 桌面端 设置 → 移动服务 中开启后，再点击“刷新屏幕”。
        </p>
      ) : screenError ? (
        <p className="error" role="alert" data-testid="mobile-screen-error">{screenError}</p>
      ) : screen ? (
        <>
          <img
            className="desktop-screen-img"
            data-testid="mobile-screen-image"
            alt={`桌面屏幕 ${screen.display_name || screen.display_id}`}
            src={`data:${screen.mime};base64,${screen.image_b64}`}
          />
          <p className="note" data-testid="mobile-screen-meta">
            显示器：{screen.display_name || screen.display_id} · 画面 {screen.width}×{screen.height}（物理 {screen.screen_width}×{screen.screen_height}）
          </p>
        </>
      ) : (
        <p className="muted" data-testid="mobile-screen-loading">
          {screenLoading ? "正在获取当前桌面屏幕…" : "点击“刷新屏幕”查看当前桌面画面。"}
        </p>
      )}
    </section>

    <section className="card" data-testid="mobile-browser-card">
      <h2>在 Taomni 服务端打开浏览器</h2>
      <p className="muted">网页会在服务端桌面窗口打开；开启屏幕查看后可在上方直接查看与刷新页面，并选中该窗口输入。</p>
      <form className="command-bar" onSubmit={e => void openServerBrowser(e)}>
        <input
          type="text"
          aria-label="服务端浏览器地址"
          data-testid="mobile-browser-url"
          placeholder="https://example.com 或 http://localhost:3000"
          value={browserUrl}
          onChange={e => setBrowserUrl(e.target.value)}
        />
        <button type="submit" className="primary" data-testid="mobile-browser-open" disabled={browserOpening}>
          {browserOpening ? "打开中…" : "打开网址"}
        </button>
      </form>
      {browserResult && <p className="note" data-testid="mobile-browser-status">
        已在服务端打开：{browserResult.url}（窗口：{browserResult.title}）
        {!browserResult.screen_capture_enabled ? "。注意：当前未开启屏幕查看，需在桌面设置开启后才能远程看图。" : ""}
      </p>}
      {browserError && <p className="error" role="alert" data-testid="mobile-browser-error">{browserError}</p>}
    </section>

    <section className="card" data-testid="mobile-windows-card">
      <div className="section-heading">
        <h2>指定窗口输入</h2>
        <div className="heading-actions">
          <button
            type="button"
            data-testid="mobile-windows-refresh"
            disabled={windowsLoading}
            onClick={() => void refreshWindows()}
          >{windowsLoading ? "刷新中…" : "刷新窗口"}</button>
        </div>
      </div>

      {windowsError && <p className="error" role="alert" data-testid="mobile-windows-error">{windowsError}</p>}

      {windows.length > 0 ? <>
        <label>
          目标窗口（{windows.length} 个可用）
          <select
            data-testid="mobile-window-select"
            value={selectedWindowId}
            onChange={e => setSelectedWindowId(e.target.value)}
          >
            {windows.map(win => <option key={win.id} value={win.id}>
              {win.title || "(无标题)"}{win.app_name ? ` — ${win.app_name}` : ""}{win.kind === "tauri_browser" ? " [服务端浏览器]" : ""}{win.focused ? " [当前聚焦]" : ""}
            </option>)}
          </select>
        </label>
        <div className="window-chips">
          {windows.slice(0, 8).map(win => <button
            type="button"
            key={win.id}
            data-testid="mobile-window-item"
            data-window-id={win.id}
            aria-pressed={win.id === selectedWindowId}
            className="window-chip"
            onClick={() => setSelectedWindowId(win.id)}
          >
            <strong>{win.title || "(无标题)"}</strong>
            <small>{win.app_name || win.kind}{win.focused ? " · 聚焦" : ""}{win.minimized ? " · 最小化" : ""}</small>
          </button>)}
        </div>
      </> : !windowsLoading && !windowsError ? (
        <p className="muted" data-testid="mobile-windows-empty">未检测到可用桌面窗口，请先刷新或打开应用窗口。</p>
      ) : null}

      <form onSubmit={e => void onSubmitWindowInput(e)}>
        <label>
          {activeWindow ? `发送到：${activeWindow.title || activeWindow.id}` : "发送输入文本"}
          <textarea
            data-testid="mobile-window-input"
            placeholder="输入要发送到所选窗口的文本…"
            value={windowText}
            onChange={e => setWindowText(e.target.value)}
          />
        </label>
        <div className="actions">
          <label className="inline-check">
            <input
              type="checkbox"
              data-testid="mobile-window-submit"
              checked={submitWithEnter}
              onChange={e => setSubmitWithEnter(e.target.checked)}
            />
            发送后附带回车 (Enter)
          </label>
          <button
            type="submit"
            className="primary"
            data-testid="mobile-window-send"
            disabled={sendingInput || !selectedWindowId}
          >{sendingInput ? "发送中…" : "发送输入"}</button>
        </div>
      </form>

      <div className="keys" aria-label="快捷窗口按键">
        {QUICK_KEYS.map(item => <button
          type="button"
          key={item.id}
          data-testid={`mobile-window-key-${item.id}`}
          disabled={sendingInput || !selectedWindowId}
          onClick={() => void deliverWindowInput({ text: "", key: item.id, submit: false })}
        >{item.label}</button>)}
      </div>

      {inputResult && <p className="note" data-testid="mobile-window-result">{inputResult}</p>}
      {inputError && <p className="error" role="alert" data-testid="mobile-window-error">{inputError}</p>}
    </section>
  </div>;
}
