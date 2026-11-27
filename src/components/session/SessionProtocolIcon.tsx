import {
  Database, FileText, Folder, Globe, Mail, Monitor, Server, Terminal, Wifi, type LucideIcon,
} from "lucide-react";

const blue = "var(--taomni-accent)";
const green = "var(--taomni-success-text)";
const amber = "var(--taomni-warning-text)";
const red = "var(--taomni-danger-text)";
const violet = "var(--taomni-protocol-violet)";

type ProtocolAppearance = readonly [LucideIcon, string];

const appearance = new Map<string, ProtocolAppearance>([
  ["SSH", [Terminal, blue]],
  ["RDP", [Monitor, violet]],
  ["VNC", [Monitor, amber]],
  ["SFTP", [Folder, blue]],
  ["FTP", [Folder, blue]],
  ["Rlogin", [Terminal, green]],
  ["Mosh", [Server, violet]],
  ["Browser", [Globe, blue]],
  ["Serial", [Wifi, blue]],
  ["WSL", [Terminal, blue]],
  ["LocalShell", [Terminal, green]],
  ["MySQL", [Database, blue]],
  ["PostgreSQL", [Database, blue]],
  ["PanWeiDB", [Database, green]],
  ["Oracle", [Database, red]],
  ["SQLServer", [Database, red]],
  ["StarRocks", [Database, green]],
  ["ClickHouse", [Database, amber]],
  ["Presto", [Database, violet]],
  ["Redis", [Database, red]],
  ["HBaseShell", [Database, green]],
  ["Mail", [Mail, green]],
  ["File", [FileText, "var(--taomni-text-muted)"]],
]);

export function dbEngineColor(engine?: string) {
  return appearance.get(engine ?? "")?.[1] ?? blue;
}

export function SessionProtocolIcon({ protocol, className, database = false }: {
  protocol: string;
  className: string;
  database?: boolean;
}) {
  const entry = appearance.get(protocol);
  const Icon = database ? Database : entry?.[0] ?? Terminal;
  return <Icon aria-hidden="true" data-session-protocol={protocol} className={className}
    style={{ color: entry?.[1] ?? blue }} />;
}
