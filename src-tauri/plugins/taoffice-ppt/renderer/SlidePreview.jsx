import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button.tsx";
import { SlideNavigation } from "./SlideNavigation.jsx";

const { React } = globalThis.__taomniHost;
const { useEffect, useMemo, useRef, useState } = React;

function sandboxDocument() {
  const script = new URL(/* @vite-ignore */ "./slide-engine.js", import.meta.url).href;
  const policy = "default-src 'none'; script-src " + script
    + "; img-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'
    + policy + '"><script src="' + script + '"></script>';
}

const html = sandboxDocument();
const TIMEOUT = 25_000;

function isSameSlide(previous, next) {
  return previous?.bytes === next.bytes && previous.slide === next.slide
    && previous.width === next.width && previous.height === next.height;
}

export function SlidePreview({ bytes, slide, width, height, description, label, titles, active, select, children }) {
  const frame = useRef(null);
  const thumbnails = useMemo(() => new Map(), [bytes]);
  const [visible, setVisible] = useState([]);
  const [, updateThumbnails] = useState(0);
  useEffect(() => () => {
    for (const url of thumbnails.values()) if (url) URL.revokeObjectURL(url);
    thumbnails.clear();
  }, [thumbnails]);
  const request = useRef({});
  request.current = { bytes, slide, width, height, thumbnails, visible };
  const connection = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const [decoded, setDecoded] = useState(null);

  useEffect(() => {
    const channel = new MessageChannel();
    let ready = false;
    let closed = false;
    let pending;
    let completed;
    let loadedBytes;
    let sequence = 0;
    let timeout;
    let url;
    function resetTimeout(target) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fail(target ?? request.current), TIMEOUT);
    }
    function fail(target) {
      if (closed) return;
      close();
      if (target.thumbnailOnly) {
        if (target.thumbnails === request.current.thumbnails) target.thumbnails.set(target.slide, null);
        setAttempt(value => value + 1);
        return;
      }
      setResult({ ...target, failed: true });
    }
    function pump() {
      if (!ready || closed || pending) return;
      const desired = request.current;
      const thumbnailOnly = isSameSlide(completed, desired);
      const index = thumbnailOnly ? desired.visible.find(index => !desired.thumbnails.has(index)) : desired.slide;
      if (index === undefined) return;
      pending = { ...desired, slide: index, thumbnailOnly, id: ++sequence };
      const changedSource = loadedBytes !== desired.bytes;
      const buffer = changedSource ? desired.bytes.slice().buffer : undefined;
      resetTimeout(pending);
      channel.port1.postMessage(
        { id: sequence, index, width: desired.width, height: desired.height, bytes: buffer, thumbnailOnly },
        buffer ? [buffer] : [],
      );
    }
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      if (url) URL.revokeObjectURL(url);
    }
    channel.port1.onmessage = ({ data }) => {
      if (closed) return;
      if (data.ready === true && !ready) {
        ready = true;
        pump();
        return;
      }
      if (!pending || data.id !== pending.id) return;
      clearTimeout(timeout);
      const rendered = pending;
      pending = undefined;
      loadedBytes = rendered.bytes;
      if (request.current.thumbnails === rendered.thumbnails && !rendered.thumbnails.has(rendered.slide)
        && (data.thumb instanceof Blob || rendered.thumbnailOnly)) {
        rendered.thumbnails.set(rendered.slide, data.thumb instanceof Blob ? URL.createObjectURL(data.thumb) : null);
        updateThumbnails(value => value + 1);
      }
      if (rendered.thumbnailOnly) {
        pump();
        return;
      }
      completed = rendered;
      if (!(data.image instanceof Blob)) {
        fail(completed);
        return;
      }
      if (isSameSlide(completed, request.current)) {
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(data.image);
        setResult({ ...completed, url });
      }
      pump();
    };
    const endpoint = frame.current;
    function connect() {
      if (!endpoint?.contentWindow) return;
      endpoint.contentWindow.postMessage("taoffice-ppt-renderer", "*", [channel.port2]);
    }
    endpoint?.addEventListener("load", connect, { once: true });
    endpoint?.setAttribute("srcdoc", html);
    resetTimeout();
    connection.current = pump;
    return () => {
      endpoint?.removeEventListener("load", connect);
      connection.current = null;
      close();
    };
  }, [attempt]);

  function retry() {
    setResult(null);
    setAttempt((value) => value + 1);
  }

  useEffect(() => {
    if (result?.failed && !isSameSlide(result, request.current)) {
      retry();
      return;
    }
    connection.current?.();
  }, [bytes, slide, width, height, result, visible]);

  const current = isSameSlide(result, request.current) ? result : null;
  return <div className="taoffice-ppt-normal">
    {titles && <SlideNavigation titles={titles} selected={slide} active={active} thumbnails={thumbnails}
      width={width} height={height} select={select} observe={setVisible} label={label} />}
    <iframe key={attempt} ref={frame} title={label("幻灯片渲染引擎", "Slide rendering engine")}
      sandbox="allow-scripts" hidden />
    {children || <div className="taoffice-ppt-slide" aria-busy={!current || (Boolean(current.url) && decoded !== current.url)} aria-label={description}>
    {current?.url ? <img key={current.url} src={current.url} alt={description} data-testid="taoffice-ppt-preview"
      data-image-ready={decoded === current.url} onLoad={() => setDecoded(current.url)} /> : current?.failed ? <>
      <p role="alert" className="taoffice-ppt-feedback">{label("无法显示幻灯片。", "Could not display the slide.")}</p>
      <Button onClick={retry}>{label("重试", "Retry")}</Button>
    </> : <p role="status" className="taoffice-ppt-feedback">{label("正在渲染幻灯片…", "Rendering slide…")}</p>}
    </div>}
  </div>;
}
