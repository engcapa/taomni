import { KeyRound, ShieldCheck } from "lucide-react";

export function NoKeyCard({ onOpenSettings, canReuse }: { onOpenSettings?: () => void; canReuse: boolean }) {
  return <div className="tao-home-no-key-card" data-testid="tao-home-connect-card"><div className="tao-home-no-key-icon"><KeyRound size={24} /></div><div><h2>连接 DeepSeek · 全家桶</h2><p>Key 只保存在 Vault，Tao 不会把明文放进前端或日志。</p><div className="tao-home-no-key-actions"><button type="button" className="primary" data-testid="tao-home-open-settings" onClick={onOpenSettings}>去设置</button>{canReuse ? <button type="button" data-testid="tao-home-reuse-key" onClick={onOpenSettings}>沿用已有 Key</button> : null}</div><small><ShieldCheck size={12} /> 代理失败会显式提示，不会静默直连</small></div></div>;
}
