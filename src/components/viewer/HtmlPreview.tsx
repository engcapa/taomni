import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { html } from "@codemirror/lang-html";
import {
  ArrowLeft, ArrowRight, Bug, Code2, ExternalLink, Monitor, RefreshCw, Save,
  ShieldCheck, Smartphone, Tablet, Trash2, X,
} from "lucide-react";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { openFile } from "../../lib/openFile";
import { useFileOpenPreferences } from "../../lib/openFile/preferences";
import { basename, openExternalUrl, parentPath, sftpOpenPath } from "../../lib/sftp";
import { type ViewerDocument } from "../../lib/viewer";
import { useDocumentStore } from "../../stores/documentStore";
import { EditorSurface } from "./EditorSurface";
import {
  browserPreviewSession, externalPreviewHref, htmlFileAddress, localPreviewHref, previewRoute, previewRouteUrl,
  pushHtmlHistory, readHtmlBridgeMessage, type HtmlConsoleLevel, type HtmlHistory,
} from "./HtmlPreviewBridge";
import { useHtmlPreviewSession } from "./HtmlPreviewSession";
import { HtmlPreviewExternalLinkDialog } from "./HtmlPreviewExternalLinkDialog";
import { useViewerLabels } from "./viewerLabels";
import "./HtmlPreview.css";

const HTML_EXTENSIONS = [html()];
const ZOOM_VALUES = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200];
type HtmlPreviewProps = { document: ViewerDocument; onError: (message: string) => void; visible?: boolean; workspaceId?: string };
type ConsoleEntry = { id: number; level: HtmlConsoleLevel; message: string };

export function HtmlPreview(props: HtmlPreviewProps) {
  return <HtmlPreviewContent key={props.document.key} {...props} />;
}

function HtmlPreviewContent({ document, onError, visible = true, workspaceId }: HtmlPreviewProps) {
  const label = useViewerLabels();
  const preferences = useFileOpenPreferences();
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [split, setSplit] = useState(false);
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [zoom, setZoom] = useState(100);
  const [showConsole, setShowConsole] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [history, setHistory] = useState<HtmlHistory>({ entries: [], index: -1 });
  const [frameLoading, setFrameLoading] = useState(true);
  const [frameError, setFrameError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stageWidth, setStageWidth] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const consoleId = useRef(0);
  const [externalLink, setExternalLink] = useState<{ href: string; token: string }>();
  const pendingExternal = useRef<{ href: string; token: string } | undefined>(undefined);
  const externalCooldownUntil = useRef(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const { session, error, loading, refresh } = useHtmlPreviewSession({
    path: document.path, savedHash: document.savedHash, mtime: document.mtime,
    allowNetwork, allowScripts: preferences.htmlScripts, visible,
    proxyMode: preferences.htmlProxyMode, customProxy: preferences.htmlCustomProxy,
  });
  const proxyLabel = session?.proxyMode === "custom" ? label("HTML 独立代理", "HTML-specific proxy")
    : session?.proxyMode === "none" ? label("不使用代理（绕过系统代理）", "No proxy (bypass system proxies)") : label("应用代理", "Application proxy");
  const initialRoute = session ? previewRoute(session.url, session) ?? "" : "";
  const currentRoute = history.entries[history.index] ?? initialRoute;
  const src = useMemo(() => session ? previewRouteUrl(currentRoute, session) ?? session.url : undefined, [session, currentRoute]);
  const address = htmlFileAddress(document.path, currentRoute, initialRoute);
  const frameWidth = device === "mobile" ? 390 : device === "tablet" ? 768 : Math.max(1, stageWidth - 48) * 100 / zoom;
  const desktopWidth = device === "desktop" && !stageWidth ? "100%" : frameWidth;

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setStageWidth(element.clientWidth);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [split]);
  useEffect(() => { setFrameLoading(true); setFrameError(""); }, [src]);
  useEffect(() => {
    if (visible && pendingExternal.current?.token === session?.token) return;
    if (pendingExternal.current) externalCooldownUntil.current = Date.now() + 1000;
    pendingExternal.current = undefined;
    setExternalLink(undefined);
  }, [visible, session?.token]);
  useEffect(() => {
    if (!src || !visible || !frameLoading) return;
    const timer = window.setTimeout(() => setFrameError(label("预览加载超时。请查看控制台或重试。", "Preview loading timed out. Check the console or retry.")), 15000);
    return () => window.clearTimeout(timer);
  }, [src, visible, frameLoading, label]);
  useLayoutEffect(() => {
    if (!session) return;
    // Subscribe in the iframe mount commit, before its first console/load bridge
    // message can arrive; passive effects can run after a fast local page loads.
    setHistory((current) => current.entries.length ? current : { entries: [previewRoute(session.url, session) ?? ""], index: 0 });
    const receive = (event: MessageEvent) => {
      const message = readHtmlBridgeMessage(event, iframe.current?.contentWindow ?? null, session);
      if (!message) return;
      if (message.kind === "navigate" && message.href) {
        const href = localPreviewHref(message.href, session, src);
        const route = href && previewRoute(href, session);
        if (typeof route === "string") setHistory((current) => pushHtmlHistory(current, route));
        else if (browserPreviewSession(session)) setConsoleEntries((current) => [...current.slice(-299), {
          id: ++consoleId.current, level: "warn", message: label("浏览器预览无法在本地文件间导航。请在原生应用中验证本地导航。", "Browser preview cannot navigate local files. Verify local navigation in the native app."),
        }]);
      } else if (message.kind === "external" && message.href) {
        const href = externalPreviewHref(message.href);
        // Source + token identify the frame, not a genuine click: author scripts
        // know both. Hold one request synchronously and require parent consent.
        if (href && visibleRef.current && !pendingExternal.current && Date.now() >= externalCooldownUntil.current) {
          const request = { href, token: session.token };
          pendingExternal.current = request;
          setExternalLink(request);
        }
      } else if (message.kind === "console" || message.kind === "blocked") {
        const text = message.message || message.href;
        if (!text) return;
        const id = ++consoleId.current;
        setConsoleEntries((current) => [...current.slice(-299), { id,
          level: message.kind === "blocked" ? "warn" : message.level ?? "log", message: message.kind === "blocked" && message.message && message.href ? `${message.message} — ${message.href}` : text }]);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [session, src, onError, label]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const decideExternal = (open: boolean) => {
    const request = pendingExternal.current;
    pendingExternal.current = undefined;
    externalCooldownUntil.current = Date.now() + 1000;
    setExternalLink(undefined);
    if (open && visible && request && request.token === session?.token) {
      const href = externalPreviewHref(request.href);
      if (href) void openExternalUrl(href).catch((cause) => onError(String(cause)));
    }
  };
  const move = (delta: number) => setHistory((current) => ({ ...current, index: Math.max(0, Math.min(current.entries.length - 1, current.index + delta)) }));
  const reload = () => { setFrameError(""); setConsoleEntries([]); refresh(); };
  const saveAndReload = () => run(async () => {
    await useDocumentStore.getState().save(document.path);
    reload();
  });
  const changeZoom = (direction: number) => setZoom((current) => ZOOM_VALUES[Math.max(0, Math.min(ZOOM_VALUES.length - 1, ZOOM_VALUES.indexOf(current) + direction))]);
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
      (event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true],.cm-editor")) return;
    if (["+", "="].includes(event.key)) { event.preventDefault(); changeZoom(1); }
    else if (event.key === "-") { event.preventDefault(); changeZoom(-1); }
    else if (event.key === "0") { event.preventDefault(); setZoom(100); }
  };
  const allowOnce = () => {
    if (preferences.htmlNetwork === "ask" && !window.confirm(label("仅在此标签中允许页面访问外部网络？关闭标签后将恢复阻止。", "Allow this page to access external networks in this tab only? Blocking resumes when the tab closes."))) return;
    setConsoleEntries([]); setAllowNetwork(true);
  };

  return <div className="html-preview" data-testid="html-preview" data-loaded={!!src && !loading && !frameLoading && !error && !frameError} onKeyDown={keyboard}>
    <div className="fv-bar html-toolbar">
      <button type="button" className="fv-icon-button" data-testid="html-back" aria-label={label("后退", "Back")} title={label("后退", "Back")} disabled={history.index <= 0 || loading} onClick={() => move(-1)}><ArrowLeft /></button>
      <button type="button" className="fv-icon-button" data-testid="html-forward" aria-label={label("前进", "Forward")} title={label("前进", "Forward")} disabled={history.index >= history.entries.length - 1 || loading} onClick={() => move(1)}><ArrowRight /></button>
      <button type="button" className="fv-icon-button" data-testid="html-refresh" aria-label={label("刷新", "Refresh")} title={label("刷新", "Refresh")} disabled={loading} onClick={reload}><RefreshCw /></button>
      <div className="html-address"><span className="html-sandbox"><ShieldCheck />{label("沙盒", "Sandbox")}</span><input readOnly value={address} title={address} aria-label={label("文件地址（只读）", "File address (read only)")} data-testid="html-address" /></div>
      <div className="fv-seg" aria-label={label("设备尺寸", "Device size")}>
        {(["desktop", "tablet", "mobile"] as const).map((value, index) => <button type="button" key={value} className={device === value ? "on" : ""} aria-pressed={device === value}
          data-testid={`html-device-${value}`} title={[label("桌面 · 自适应", "Desktop · responsive"), label("平板 768", "Tablet 768"), label("手机 390", "Mobile 390")][index]}
          aria-label={[label("桌面", "Desktop"), label("平板 768", "Tablet 768"), label("手机 390", "Mobile 390")][index]} onClick={() => setDevice(value)}>{index === 0 ? <Monitor /> : index === 1 ? <Tablet /> : <Smartphone />}</button>)}
      </div>
      <select className="html-zoom" data-testid="html-zoom" value={zoom} aria-label={label("页面缩放", "Page zoom")} onChange={(event) => setZoom(Number(event.target.value))}>{ZOOM_VALUES.map((value) => <option key={value} value={value}>{value}%</option>)}</select>
      <div className="fv-seg" aria-label={label("HTML 视图", "HTML view")}>
        <button type="button" className={!split ? "on" : ""} data-testid="html-mode-preview" aria-pressed={!split} onClick={() => setSplit(false)}>{label("预览", "Preview")}</button>
        <button type="button" className={split ? "on" : ""} data-testid="html-mode-split" aria-pressed={split} onClick={() => setSplit(true)}>{label("源码分栏", "Source split")}</button>
      </div>
      <button type="button" className={`fv-icon-button${showConsole ? " on" : ""}`} data-testid="html-console-toggle" title={label("控制台", "Console")} aria-label={label("控制台", "Console")} aria-pressed={showConsole} onClick={() => setShowConsole((value) => !value)}><Bug /></button>
      <button type="button" className="fv-icon-button" data-testid="html-system-open" title={label("用系统浏览器打开", "Open in system browser")} aria-label={label("用系统浏览器打开", "Open in system browser")} onClick={() => void run(() => sftpOpenPath(document.path))}><ExternalLink /></button>
      <button type="button" className="fv-icon-button" data-testid="html-workspace-open" disabled={!!document.readOnlyReason} title={label("在 Workspace 中编辑", "Edit in Workspace")} aria-label={label("在 Workspace 中编辑", "Edit in Workspace")} onClick={() => void run(() => openFile({ path: document.path }, { context: "viewer", mode: "workspace", ...(workspaceId ? { workspaceId } : {}) }))}><Code2 /></button>
    </div>
    <div className={`fv-banner html-network-banner${allowNetwork ? " network-allowed" : ""}`} data-testid="html-network-banner" role="status">
      <ShieldCheck />
      <span>{allowNetwork ? label("本次已允许网络请求（仅此标签，关闭后恢复）", "Network access allowed for this tab only; blocking resumes when closed") : label("网络请求已阻止 · 本地资源（同目录及子目录）可读取", "Network requests blocked · Local resources in this directory and subdirectories are available")}
        {allowNetwork && session?.allowNetwork && <span data-testid="html-network-proxy" data-proxy-mode={session.proxyMode}> · {proxyLabel}</span>}
        <span className="html-script-policy"> · {preferences.htmlScripts ? label("脚本在隔离沙盒中运行", "Scripts run in an isolated sandbox") : label("页面脚本已关闭", "Page scripts are disabled")}</span></span>
      <span className="fv-spacer" />
      {!allowNetwork && <button type="button" className="fv-button" data-testid="html-network-allow" onClick={allowOnce}>{label("本次允许网络", "Allow network this time")}</button>}
      {allowNetwork && <button type="button" className="fv-button" data-testid="html-network-block" onClick={() => { setAllowNetwork(false); setConsoleEntries([]); }}>{label("阻止网络", "Block network")}</button>}
    </div>
    {document.dirty && <div className="fv-banner html-dirty-banner"><span>{label("预览显示磁盘上已保存的版本；保存后刷新。", "The preview shows the saved version on disk. Save to refresh.")}</span><span className="fv-spacer" /><button type="button" className="fv-button" data-testid="html-save-refresh" disabled={busy || document.readOnly} onClick={() => void saveAndReload()}><Save />{label("保存并刷新", "Save and refresh")}</button></div>}
    <div className="html-body">
      <div className="html-source" data-testid="html-source" hidden={!split}><div className="html-source-label">{basename(document.path)}</div><EditorSurface document={document} extensions={HTML_EXTENSIONS} /></div>
      <div className="html-stage" data-testid="html-stage" ref={stage}>
        {src && !error && <div className="html-page-shell" data-device={device} style={{ width: typeof desktopWidth === "number" ? desktopWidth * zoom / 100 : desktopWidth }}>
          <iframe key={session?.token} ref={iframe} className="html-frame" data-testid="html-frame" title={label("本地 HTML 沙盒预览", "Local HTML sandbox preview")}
            src={src} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            style={{ width: desktopWidth, height: `${10000 / zoom}%`, transform: `scale(${zoom / 100})` }}
            onLoad={() => { setFrameLoading(false); setFrameError(""); }} onError={() => { setFrameLoading(false); setFrameError(label("HTML 预览加载失败", "HTML preview failed to load")); }} />
        </div>}
        {(loading || (!src && !error) || (frameLoading && !frameError)) && <div className="html-loading" role="status">{label("正在加载本地预览…", "Loading local preview…")}</div>}
        {(error || frameError) && <div className="html-error" role="alert"><p>{error || frameError}</p><div><button type="button" className="fv-button" onClick={reload}>{label("重试", "Retry")}</button><button type="button" className="fv-button" onClick={() => void run(() => sftpOpenPath(document.path))}>{label("系统应用", "System app")}</button><button type="button" className="fv-button" onClick={() => void run(() => openExplorer(parentPath(document.path), workspaceId ? { workspaceId } : undefined))}>{label("在 Explorer 中显示", "Show in Explorer")}</button></div></div>}
      </div>
    </div>
    {showConsole && <section className="html-console" data-testid="html-console" aria-label={label("控制台", "Console")}><div className="html-console-header"><strong>{label("控制台", "Console")}</strong><span className="html-console-count">{consoleEntries.length}</span><span className="fv-spacer" />
      <button type="button" className="fv-icon-button" data-testid="html-console-clear" title={label("清空控制台", "Clear console")} aria-label={label("清空控制台", "Clear console")} onClick={() => setConsoleEntries([])}><Trash2 /></button><button type="button" className="fv-icon-button" title={label("关闭控制台", "Close console")} aria-label={label("关闭控制台", "Close console")} onClick={() => setShowConsole(false)}><X /></button></div>
      <div className="html-console-lines" role="log">{consoleEntries.length ? consoleEntries.map((entry) => <div key={entry.id} className={`html-console-entry level-${entry.level}`} data-level={entry.level}>{entry.message}</div>) : <div className="html-console-empty">{label("暂无控制台消息", "No console messages")}</div>}</div>
    </section>}
    {externalLink && visible && externalLink.token === session?.token && <HtmlPreviewExternalLinkDialog href={externalLink.href} onDecision={decideExternal} />}
  </div>;
}
