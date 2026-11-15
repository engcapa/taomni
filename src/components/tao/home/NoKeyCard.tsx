import { taoText as tr } from "../i18n";
import { KeyRound, ShieldCheck } from "lucide-react";

export function NoKeyCard({ onOpenSettings, onReuse, canReuse }: { onOpenSettings?: () => void; onReuse?: () => void; canReuse: boolean }) {
  return <div className="tao-home-no-key-card" data-testid="tao-home-connect-card"><div className="tao-home-no-key-icon"><KeyRound size={24} /></div><div><h2>{tr("连接 DeepSeek · 全家桶")}</h2><p>{tr("Key 由 Vault 安全保存，Tao 不会记录到日志。")}</p><div className="tao-home-no-key-actions"><button type="button" className="primary" data-testid="tao-home-open-settings" onClick={onOpenSettings}>{tr("去设置")}</button>{canReuse ? <button type="button" data-testid="tao-home-reuse-key" onClick={onReuse}>{tr("沿用已有 Key")}</button> : null}</div><small><ShieldCheck size={12} />{tr("代理失败会显式提示，不会静默直连")}</small></div></div>;
}
