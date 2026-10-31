import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { qrSvgModel, type QrSvgModel } from "../../lib/mfa/qrSvg";
interface Device { device_id: string; label: string; origin: string | null; last_used_at: number }
interface Status { enabled: boolean; address: string | null; failed_attempts: number; devices: Device[] }
export function MobileServiceSettings() {
  const [status, setStatus] = useState<Status>({ enabled: false, address: null, failed_attempts: 0, devices: [] });
  const [lan, setLan] = useState(false);
  const [port, setPort] = useState(8787);
  const [endpoint, setEndpoint] = useState("");
  const [code, setCode] = useState("");
  const [expires, setExpires] = useState(0);
  const [qr, setQr] = useState<QrSvgModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void invoke<Status>("mobile_status").then(value => { if (!disposed) setStatus(value); }).catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    let disposed = false;
    if (!code || !endpoint) { setQr(null); return; }
    void qrSvgModel(JSON.stringify({ endpoint, pairing_code: code })).then(value => { if (!disposed) setQr(value); }).catch(() => { if (!disposed) setQr(null); });
    return () => { disposed = true; };
  }, [endpoint, code]);
  useEffect(() => {
    if (!expires) return;
    const timer = setTimeout(() => { setCode(""); setQr(null); }, Math.max(0, expires - Date.now()));
    return () => clearTimeout(timer);
  }, [expires]);
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  return <section data-testid="mobile-settings" className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3 text-[13px]">
    <h3 className="font-semibold text-[14px]">移动服务 / Mobile remote</h3>
    <p className="mt-1 mb-3 text-[var(--taomni-text-muted)]">用手机浏览器查看终端与 Agent。默认关闭；服务运行与当前工作区无关。</p>
    <div className="flex flex-wrap items-center gap-3">
      <label><input data-testid="mobile-settings-lan" type="checkbox" checked={lan} disabled={busy || status.enabled} onChange={e => setLan(e.target.checked)} /> 允许局域网连接</label>
      <label>端口 <input data-testid="mobile-settings-port" className="w-20 border rounded px-2 py-1" type="number" value={port} min={0} max={65535} disabled={busy || status.enabled} onChange={e => setPort(Number(e.target.value))} /></label>
      <button data-testid="mobile-settings-toggle" className="border rounded px-3 py-1.5" disabled={busy || !Number.isInteger(port) || port < 0 || port > 65535} onClick={() => void act(async () => {
        const next = await invoke<Status>(status.enabled ? "mobile_stop" : "mobile_start", status.enabled ? {} : { lan, port });
        setStatus(next); setCode(""); setQr(null);
        if (next.address) setEndpoint(next.address);
      })}>{status.enabled ? "关闭移动服务" : "开启移动服务"}</button>
    </div>
    <p className="mt-3" data-testid="mobile-settings-status">{status.enabled ? `运行中 · ${status.address}` : "已关闭 · 无监听端口"}</p>
    {status.enabled && <div className="mt-3 space-y-3">
      <p className="text-[var(--taomni-text-muted)]">手机请使用可到达的局域网地址或自备 HTTPS endpoint；0.0.0.0 与 127.0.0.1 不能作为远程手机地址。</p>
      <label className="block">配对二维码中的实例地址<input data-testid="mobile-settings-endpoint" className="mt-1 block w-full border rounded px-2 py-1" value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://pc.example.com" /></label>
      <button data-testid="mobile-settings-pair" className="border rounded px-3 py-1.5" disabled={busy} onClick={() => void act(async () => {
        setCode(await invoke<string>("mobile_pairing_code")); setExpires(Date.now() + 300000);
        setStatus(await invoke<Status>("mobile_status"));
      })}>生成一次性配对码</button>
      {code && <div><p>5 分钟内有效，使用后失效。到期或已使用后请重新生成。</p><code data-testid="mobile-settings-code" className="select-all break-all">{code}</code>
        {qr && <svg data-testid="mobile-settings-qr" role="img" aria-label="手机配对二维码" viewBox={`0 0 ${qr.size} ${qr.size}`} width="200" height="200" className="mt-3"><path fill="white" d={`M0 0h${qr.size}v${qr.size}H0z`} /><path fill="black" d={qr.path} /></svg>}
      </div>}
      <p data-testid="mobile-settings-failures">配对失败计数：{status.failed_attempts}</p>
    </div>}
    <div className="mt-4"><h4 className="font-medium">已配对设备</h4>
      <button data-testid="mobile-settings-refresh" className="border rounded px-2 py-1 mt-2" disabled={busy} onClick={() => void act(async () => { setStatus(await invoke<Status>("mobile_status")); })}>刷新设备列表</button>
      {status.devices.map(device => <div key={device.device_id} data-testid="mobile-settings-device" className="flex flex-wrap items-center justify-between gap-2 border-t mt-2 pt-2"><span>{device.label} · {device.origin || "非浏览器"} · {new Date(device.last_used_at * 1000).toLocaleString()}</span><button data-testid="mobile-settings-revoke" className="border rounded px-2 py-1" disabled={busy} onClick={() => void act(async () => {
        await invoke("mobile_revoke", { deviceId: device.device_id }); setStatus(await invoke<Status>("mobile_status"));
      })}>吊销设备</button></div>)}
      {!status.devices.length && <p className="text-[var(--taomni-text-muted)] mt-2">暂无已配对设备</p>}
    </div>
    {error && <p role="alert" data-testid="mobile-settings-error" className="mt-2 text-red-400">{error}</p>}
  </section>;
}
