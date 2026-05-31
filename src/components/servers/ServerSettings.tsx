import type { ReactNode } from "react";
import { SERVER_DEFS, type ServerType } from "../../lib/servers";
import { useServersStore } from "../../stores/serversStore";
import { useT } from "../../lib/i18n";
import { CommonSettings } from "./CommonSettings";
import { ServerOutputLog } from "./ServerOutputLog";
import { SshSettings } from "./settings/SshSettings";
import { FtpSettings } from "./settings/FtpSettings";
import { TftpSettings } from "./settings/TftpSettings";
import { HttpSettings } from "./settings/HttpSettings";
import { TelnetSettings } from "./settings/TelnetSettings";
import { VncSettings } from "./settings/VncSettings";
import { NfsSettings } from "./settings/NfsSettings";
import { CronSettings } from "./settings/CronSettings";
import { IperfSettings } from "./settings/IperfSettings";
import { RdpSettings } from "./settings/RdpSettings";

/**
 * Right-hand panel: a header describing the selected server, the shared
 * common settings, the per-type form, and the live output console. All
 * edits flow through the store's `patchConfig`, which marks the dialog dirty.
 */
export function ServerSettings() {
  const t = useT();
  const selectedServer = useServersStore((s) => s.selectedServer);
  const config = useServersStore((s) => s.configs[selectedServer]);
  const patchConfig = useServersStore((s) => s.patchConfig);

  const def = SERVER_DEFS.find((d) => d.type === selectedServer) ?? SERVER_DEFS[0];
  const onChange = (patch: Parameters<typeof patchConfig>[1]) =>
    patchConfig(selectedServer, patch);

  const specific = renderSpecificForm(selectedServer, config, onChange);

  return (
    <div
      data-testid="server-settings"
      className="flex-1 min-w-0 h-full overflow-y-auto px-4 py-3 flex flex-col"
      style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}
    >
      <div className="text-[13px] font-semibold">{t(def.labelKey)}</div>
      <div className="border-t my-2" style={{ borderColor: "var(--moba-divider)" }} />
      <div className="text-[11px] mb-3" style={{ color: "var(--moba-text-muted)" }}>
        {t(def.descKey)}
      </div>

      <CommonSettings def={def} config={config} onChange={onChange} />

      {specific}

      <ServerOutputLog serverType={selectedServer} />
    </div>
  );
}

function renderSpecificForm(
  type: ServerType,
  config: ReturnType<typeof useServersStore.getState>["configs"][ServerType],
  onChange: (patch: Record<string, unknown>) => void,
): ReactNode {
  switch (type) {
    case "ssh":
      return <SshSettings config={config} onChange={onChange} />;
    case "ftp":
      return <FtpSettings config={config} onChange={onChange} />;
    case "tftp":
      return <TftpSettings config={config} onChange={onChange} />;
    case "http":
      return <HttpSettings config={config} onChange={onChange} />;
    case "telnet":
      return <TelnetSettings config={config} onChange={onChange} />;
    case "vnc":
      return <VncSettings config={config} onChange={onChange} />;
    case "nfs":
      return <NfsSettings config={config} onChange={onChange} />;
    case "cron":
      return <CronSettings config={config} onChange={onChange} />;
    case "iperf":
      return <IperfSettings config={config} onChange={onChange} />;
    case "rdp":
      return <RdpSettings config={config} onChange={onChange} />;
    default:
      return null;
  }
}
