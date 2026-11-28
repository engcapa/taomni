import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button.tsx";

const { React } = globalThis.__taomniHost;
const { useEffect, useRef, useState } = React;

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

export function SlidePreview({ bytes, slide, width, height, description, label }) {
  const frame = useRef(null);
  const request = useRef({});
  request.current = { bytes, slide, width, height };
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
      setResult({ ...target, failed: true });
    }
    function pump() {
      if (!ready || closed || pending) return;
      const desired = request.current;
      if (isSameSlide(completed, desired)) return;
      pending = { ...desired, id: ++sequence };
      const changedSource = completed?.bytes !== desired.bytes;
      const buffer = changedSource ? desired.bytes.slice().buffer : undefined;
      resetTimeout(pending);
      channel.port1.postMessage(
        { id: sequence, index: desired.slide, width: desired.width, height: desired.height, bytes: buffer },
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
      completed = pending;
      pending = undefined;
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
  }, [bytes, slide, width, height, result]);

  const current = isSameSlide(result, request.current) ? result : null;
  return <div className="taoffice-ppt-slide" aria-busy={!current || (Boolean(current.url) && decoded !== current.url)} aria-label={description}>
    <iframe key={attempt} ref={frame} title={label("幻灯片渲染引擎", "Slide rendering engine")}
      sandbox="allow-scripts" hidden />
    {current?.url ? <img key={current.url} src={current.url} alt={description} data-testid="taoffice-ppt-preview"
      data-image-ready={decoded === current.url} onLoad={() => setDecoded(current.url)} /> : current?.failed ? <>
      <p role="alert" className="taoffice-ppt-feedback">{label("无法显示幻灯片。", "Could not display the slide.")}</p>
      <Button onClick={retry}>{label("重试", "Retry")}</Button>
    </> : <p role="status" className="taoffice-ppt-feedback">{label("正在渲染幻灯片…", "Rendering slide…")}</p>}
  </div>;
}
