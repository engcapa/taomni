import { KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "../../ui/Button";
import { taoText as tr } from "../i18n";

export function NoKeyCard({ onOpenSettings, onReuse, canReuse }: {
  onOpenSettings?: () => void;
  onReuse?: () => void;
  canReuse: boolean;
}) {
  return (
    <div className="tao-home-no-key-card" data-testid="tao-home-connect-card">
      <div className="tao-home-no-key-icon"><KeyRound size={20} /></div>
      <div>
        <h2>{tr("配置 Tao 服务提供方")}</h2>
        <p>{tr("Key 由 Vault 安全保存，Tao 不会记录到日志。")}</p>
        <div className="tao-home-no-key-actions">
          <Button variant="primary" data-testid="tao-home-open-settings" onClick={onOpenSettings}>{tr("去设置")}</Button>
          {canReuse && <Button data-testid="tao-home-reuse-key" onClick={onReuse}>{tr("沿用已有 Key")}</Button>}
        </div>
        <small><ShieldCheck size={12} />{tr("代理失败会显式提示，不会静默直连")}</small>
      </div>
    </div>
  );
}
