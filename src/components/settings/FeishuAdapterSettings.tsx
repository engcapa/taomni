import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isVaultLockedError, type AppProxyConfig } from "../../lib/ipc";
import { ensureVaultReady } from "../../lib/vaultGate";
import { useVaultStore } from "../../stores/vaultStore";
import { AppProxyPanel } from "./AppProxyPanel";

interface Config {
  app_id: string; secret_ref: string; mobile_endpoint: string;
  bindings: { open_id: string; chat_id: string }[];
  proxy_mode: "app" | "custom" | "none"; custom_proxy: AppProxyConfig;
}
interface Status {
  state: string; error: string | null; reconnects: number; delivered: number;
  failed_deliveries: number; rejected: number; duplicates: number;
}
interface View { config: Config; status: Status; secret_configured: boolean }
const names: Record<string, string> = { stopped: "已停止", connecting: "连接中", connected: "已连接", reconnecting: "重连中" };
export function FeishuAdapterSettings({ mobileEnabled }: { mobileEnabled: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [bindings, setBindings] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let disposed = false;
    let initialized = false;
    const refresh = async () => {
      try {
        const next = await invoke<View>("mobile_feishu_get");
        if (!disposed) {
          setView(next);
          if (!initialized) {
            initialized = true;
            setDraft(next.config);
            setBindings(next.config.bindings.map(b => `${b.open_id} ${b.chat_id}`).join("\n"));
          }
        }
      } catch (e) { if (!disposed) setError(String(e)); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  if (!draft || !view) return <p data-testid="feishu-loading">正在加载飞书适配器设置…{error}</p>;
  const running = view.status.state !== "stopped";
  const parsedBindings = bindings.split("\n").filter(v => v.trim()).map(line => {
    const [open_id = "", chat_id = "", ...extra] = line.trim().split(/\s+/);
    return { open_id, chat_id: extra.length ? "" : chat_id };
  });
  const config = { ...draft, bindings: parsedBindings };
  const dirty = !!secret || JSON.stringify(config) !== JSON.stringify(view.config);
  const act = async (run: () => Promise<void>) => {
    setBusy(true); setError(""); setSaved(false);
    try {
      try { await run(); } catch (e) {
        if (!isVaultLockedError(e)) throw e;
        await useVaultStore.getState().refresh();
        if (!(await ensureVaultReady("保存或使用飞书凭据需要解锁凭据库"))) {
          throw new Error("未解锁凭据库，操作未完成；输入已保留。");
        }
        await run();
      }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const patch = (value: Partial<Config>) => { setDraft({ ...draft, ...value }); setSaved(false); };
  return <section data-testid="feishu-settings" className="mt-5 border-t pt-4 space-y-3">
    <h4 className="font-semibold">飞书 / Feishu Agent 适配器（P1）</h4>
    <p>使用企业自建应用的长连接，无需公网入站地址。先开启移动服务；关闭本页继续运行，关闭移动服务会停止适配器。</p>
    <p className="text-[var(--taomni-text-muted)]">每个 Taomni 实例使用独立应用。需开启机器人能力、订阅 im.message.receive_v1 和 card.action.trigger，并授予 im:message:send_as_bot 与 im:message.p2p_msg:readonly（私聊接收）权限。</p>
    <fieldset disabled={busy || running} className="space-y-3">
      <label className="block">App ID<input data-testid="feishu-app-id" className="taomni-input w-full" value={draft.app_id} onChange={e => patch({ app_id: e.target.value.trim() })} placeholder="cli_…" autoComplete="off" /></label>
      <label className="block">App Secret（{view.secret_configured ? "已保存；留空保留" : "保存到已解锁的凭据库"}）<input data-testid="feishu-app-secret" className="taomni-input w-full" type="password" value={secret} onChange={e => { setSecret(e.target.value); setSaved(false); }} autoComplete="new-password" /></label>
      <label className="block">通知中的 Mobile Web 地址（可选）<input data-testid="feishu-mobile-endpoint" className="taomni-input w-full" value={draft.mobile_endpoint} onChange={e => patch({ mobile_endpoint: e.target.value })} placeholder="https://pc.example.com" /></label>
      <label className="block">授权身份绑定（每行：用户 open_id 会话 chat_id）<textarea data-testid="feishu-bindings" className="taomni-input w-full" rows={3} value={bindings} onChange={e => { setBindings(e.target.value); setSaved(false); }} placeholder="ou_… oc_…" /></label>
      <p>只接受已绑定用户在指定会话中的命令或卡片操作。通知发送到这些会话；群内其他成员也能看到通知，请按需要授权。</p>
      <label className="block">网络代理<select data-testid="feishu-proxy-mode" className="taomni-input w-full" value={draft.proxy_mode} onChange={e => patch({ proxy_mode: e.target.value as Config["proxy_mode"] })}>
        <option value="app">使用应用代理（默认）</option><option value="custom">独立代理</option><option value="none">不使用代理</option>
      </select></label>
      {draft.proxy_mode === "custom" && <div data-testid="feishu-custom-proxy"><AppProxyPanel value={draft.custom_proxy} onSave={async custom_proxy => patch({ custom_proxy })} testHost="open.feishu.cn" /></div>}
    </fieldset>
    <div className="flex gap-2 flex-wrap">
      <button data-testid="feishu-save" className="border rounded px-3 py-1.5" disabled={busy || running || !dirty} onClick={() => void act(async () => {
        const next = await invoke<View>("mobile_feishu_save", { config, secret: secret || null });
        setView(next); setDraft(next.config); setSecret(""); setBindings(next.config.bindings.map(b => `${b.open_id} ${b.chat_id}`).join("\n")); setSaved(true);
      })}>保存飞书设置</button>
      <button data-testid="feishu-toggle" className="border rounded px-3 py-1.5" disabled={busy || (!running && (!mobileEnabled || dirty || !view.secret_configured || !draft.app_id || !config.bindings.length))} onClick={() => void act(async () => {
        const status = await invoke<Status>(running ? "mobile_feishu_stop" : "mobile_feishu_start");
        setView({ ...view, status });
      })}>{running ? "停止飞书连接" : "启动飞书连接"}</button>
    </div>
    {saved && <p role="status" data-testid="feishu-saved">设置已保存，密钥不会回传。</p>}
    <p data-testid="feishu-status">{names[view.status.state] || view.status.state} · 已送达 {view.status.delivered} · 发送失败 {view.status.failed_deliveries} · 拒绝 {view.status.rejected} · 重复 {view.status.duplicates} · 重连 {view.status.reconnects}</p>
    {(error || view.status.error) && <p role="alert" data-testid="feishu-error">{error || view.status.error}</p>}
    <p>发送 <code>/taomni help</code> 查看命令；支持 list、show、file、send、stop、approve、reject。只操作现有 Agent 线程，不向 PTY 输入，不创建会话。回复与快照会截断。</p>
  </section>;
}
