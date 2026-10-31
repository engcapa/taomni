import { useEffect, useRef, useState } from "react";
import { endpoint, errorText, request, type Instance } from "./api";

function Scanner({ onRead, onClose }: { onRead: (value: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout>;
    type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
    const ctor = (window as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!ctor) { setError("当前浏览器不支持扫码，请使用手动输入。"); return; }
    const detector = new ctor({ formats: ["qr_code"] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(async media => {
      stream = media;
      if (disposed) { media.getTracks().forEach(t => t.stop()); return; }
      if (!video.current) return;
      video.current.srcObject = media;
      await video.current.play();
      const scan = async () => {
        if (disposed || !video.current) return;
        try {
          const values = await detector.detect(video.current);
          if (values[0]) { onRead(values[0].rawValue); return; }
        } catch { /* camera can deliver an incomplete frame */ }
        timer = setTimeout(scan, 250);
      };
      void scan();
    }).catch(() => { if (!disposed) setError("无法使用摄像头，请允许摄像头权限或手动输入。"); });
    return () => { disposed = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); };
  }, [onRead]);
  return <div role="dialog" aria-label="扫描配对二维码" className="card"><video ref={video} playsInline muted />{error && <p role="alert">{error}</p>}<button onClick={onClose}>关闭摄像头</button></div>;
}
export function PairForm({ onPair, onCancel }: { onPair: (value: Instance) => void; onCancel: () => void }) {
  const [address, setAddress] = useState(location.origin);
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scanner, setScanner] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const read = useRef((text: string) => {
    try {
      const value = JSON.parse(text) as { endpoint: string; pairing_code: string };
      if (typeof value.endpoint !== "string" || typeof value.pairing_code !== "string") throw Error();
      setAddress(endpoint(value.endpoint)); setCode(value.pairing_code); setScanner(false);
    } catch { setError("二维码不是有效的 Taomni 配对信息。"); setScanner(false); }
  }).current;
  return <section className="card" data-testid="mobile-pair-form">
    <p className="eyebrow">NEW INSTANCE</p><h2>添加实例</h2><p className="muted">在远程实例的设置 → 移动服务中生成配对码。</p>
    <form onSubmit={async event => {
      event.preventDefault(); setError(""); setBusy(true); abort.current = new AbortController();
      try {
        const url = endpoint(address.trim());
        const pair = await request<{ device_id: string; token: string }>({ endpoint: url, token: "" }, "/pair", { endpoint_label: label.trim() || new URL(url).host, pairing_code: code.trim() }, abort.current.signal);
        onPair({ id: `${url}:${pair.device_id}`, endpoint: url, label: label.trim() || new URL(url).host, token: pair.token, deviceId: pair.device_id, lastOnline: Date.now() });
      } catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) setError(errorText(error)); }
      finally { setBusy(false); }
    }}>
      <label>实例地址<input data-testid="mobile-endpoint" type="url" required value={address} onChange={e => setAddress(e.target.value)} placeholder="https://pc.example.com" autoCapitalize="none" autoCorrect="off" /></label>
      <label>实例名称<input data-testid="mobile-label" value={label} onChange={e => setLabel(e.target.value)} placeholder="例如：家里的 PC" maxLength={80} /></label>
      <label>一次性配对码<input data-testid="mobile-pair-code" required value={code} onChange={e => setCode(e.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="off" /></label>
      {error && <p role="alert" data-testid="mobile-pair-error">{error}</p>}
      <div className="actions"><button className="primary" data-testid="mobile-pair-submit" disabled={busy}>{busy ? "配对中…" : "连接并配对"}</button><button type="button" onClick={onCancel}>取消</button>
        {window.isSecureContext && <button type="button" onClick={() => setScanner(true)}>扫描二维码</button>}</div>
    </form>
    {scanner && <Scanner onRead={read} onClose={() => setScanner(false)} />}
    <p className="note">配对凭据保存在当前浏览器中，安全性低于系统钥匙串。请仅在自己的设备上配对。</p>
  </section>;
}
