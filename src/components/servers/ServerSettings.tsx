import { SERVER_DEFS } from "../../lib/servers";
import { useServersStore } from "../../stores/serversStore";
import { useT } from "../../lib/i18n";
import { CommonSettings } from "./CommonSettings";
import { ServerOutputLog } from "./ServerOutputLog";
import { ModuleServerSettings } from "./ModuleServerSettings";

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

  return (
    <div
      data-testid="server-settings"
      className="flex-1 min-w-0 h-full overflow-y-auto px-4 py-3 flex flex-col"
      style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
    >
      <div className="text-[13px] font-semibold">{t(def.labelKey)}</div>
      <div className="border-t my-2" style={{ borderColor: "var(--taomni-divider)" }} />
      <div className="text-[11px] mb-3" style={{ color: "var(--taomni-text-muted)" }}>
        {t(def.descKey)}
      </div>

      <CommonSettings def={def} config={config} onChange={onChange} />

      <ModuleServerSettings serverType={selectedServer} config={config} onChange={onChange} />

      <ServerOutputLog serverType={selectedServer} />
    </div>
  );
}
