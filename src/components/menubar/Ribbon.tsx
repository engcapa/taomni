import {
  Terminal as TerminalIcon,
  Server,
  Wrench,
  Layout,
  SplitSquareVertical,
  Users,
  Network,
  Package,
  Settings,
  HelpCircle,
  Monitor,
  Power,
  FolderTree,
} from "lucide-react";
import { useT } from "../../lib/i18n";

export type RibbonCommand =
  | "new-session"
  | "new-terminal"
  | "new-sftp"
  | "servers"
  | "tools"
  | "sessions"
  | "view"
  | "split"
  | "multiexec"
  | "tunneling"
  | "packages"
  | "settings"
  | "macros"
  | "help"
  | "toggle-xserver"
  | "toggle-compact"
  | "exit";

interface RibbonProps {
  xServerEnabled: boolean;
  splitActive?: boolean;
  onCommand: (command: RibbonCommand) => void;
}

export function Ribbon({ xServerEnabled, splitActive, onCommand }: RibbonProps) {
  const t = useT();
  return (
    <div data-testid="ribbon" className="moba-ribbon px-2 pt-1.5 pb-1 flex items-end gap-1">
      <RibbonBtn id="session" icon={<TerminalIcon className="w-6 h-6" style={{ color: "#2b5d8b" }} />} label={t("ribbon.newSession")} highlight onClick={() => onCommand("new-session")} />
      <RibbonBtn id="sftp" icon={<FolderTree className="w-6 h-6" style={{ color: "#1f7a4a" }} />} label={t("ribbon.newSftp")} onClick={() => onCommand("new-sftp")} />
      <RibbonBtn id="servers" icon={<Server className="w-6 h-6" style={{ color: "#3b7ac2" }} />} label={t("ribbon.serversTab")} onClick={() => onCommand("servers")} />
      <RibbonBtn id="tools" icon={<Wrench className="w-6 h-6" style={{ color: "#5b8a4a" }} />} label={t("ribbon.toolsTab")} onClick={() => onCommand("tools")} />
      <RibbonBtn id="view" icon={<Layout className="w-6 h-6" style={{ color: "#3b7ac2" }} />} label={t("menu.view")} onClick={() => onCommand("view")} />
      <RibbonBtn id="split" icon={<SplitSquareVertical className="w-6 h-6" style={{ color: "#2b5d8b" }} />} label={t("ribbon.splitView")} active={splitActive} onClick={() => onCommand("split")} />
      <RibbonBtn id="multiexec" icon={<Users className="w-6 h-6" style={{ color: "#7a3d9d" }} />} label={t("ribbon.multiExec")} onClick={() => onCommand("multiexec")} />
      <RibbonBtn id="tunneling" icon={<Network className="w-6 h-6" style={{ color: "#236a98" }} />} label={t("ribbon.tunneling")} onClick={() => onCommand("tunneling")} />
      <RibbonBtn id="packages" icon={<Package className="w-6 h-6" style={{ color: "#7a4f1a" }} />} label={t("ribbon.packages")} onClick={() => onCommand("packages")} />
      <RibbonBtn id="settings" icon={<Settings className="w-6 h-6" style={{ color: "var(--moba-text-muted)" }} />} label={t("ribbon.settings")} onClick={() => onCommand("settings")} />
      <RibbonBtn id="help" icon={<HelpCircle className="w-6 h-6" style={{ color: "#1f6db8" }} />} label={t("ribbon.help")} onClick={() => onCommand("help")} />
      <div className="flex-1" />
      <div className="flex items-center gap-2 mr-2">
        <span className="moba-pill">
          <span className={`w-1.5 h-1.5 rounded-full inline-block ${xServerEnabled ? "bg-emerald-500" : "bg-slate-400"}`} /> {t("menu.xserver")}: {xServerEnabled ? t("common.enabled") : t("common.disabled")}
        </span>
        <RibbonBtn id="x-server" icon={<Monitor className="w-6 h-6" style={{ color: "#2b5d8b" }} />} label={t("menu.xserver")} onClick={() => onCommand("toggle-xserver")} />
        <RibbonBtn id="exit" icon={<Power className="w-6 h-6" style={{ color: "#b22222" }} />} label={t("ribbon.exit")} onClick={() => onCommand("exit")} />
      </div>
    </div>
  );
}

function RibbonBtn({
  id,
  icon,
  label,
  highlight,
  active,
  onClick,
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  highlight?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      data-testid={`ribbon-${id}`}
      className="moba-ribbon-btn"
      onClick={onClick}
      type="button"
      style={
        active
          ? { background: "var(--moba-selected)", outline: "1px solid var(--moba-accent)" }
          : highlight
          ? { background: "var(--moba-control-hover)", outline: "1px solid var(--moba-tab-border)" }
          : undefined
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
