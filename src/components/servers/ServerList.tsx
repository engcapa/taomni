import { SERVER_DEFS } from "../../lib/servers";
import { useServersStore } from "../../stores/serversStore";
import { ServerRow } from "./ServerRow";

/**
 * Left rail of the servers dialog: one selectable row per server type,
 * each reflecting its live run state and exposing start/stop/settings.
 */
export function ServerList() {
  const selectedServer = useServersStore((s) => s.selectedServer);
  const runtimes = useServersStore((s) => s.runtimes);
  const selectServer = useServersStore((s) => s.selectServer);
  const start = useServersStore((s) => s.start);
  const stop = useServersStore((s) => s.stop);

  return (
    <div
      role="listbox"
      aria-label="Servers"
      data-testid="server-list"
      className="h-full overflow-y-auto shrink-0"
      style={{
        width: 220,
        borderRight: "1px solid var(--taomni-divider)",
        background: "var(--taomni-chrome-bg)",
      }}
    >
      {SERVER_DEFS.map((def) => (
        <ServerRow
          key={def.type}
          def={def}
          status={runtimes[def.type]?.status ?? "stopped"}
          selected={selectedServer === def.type}
          onSelect={() => selectServer(def.type)}
          onStart={() => void start(def.type)}
          onStop={() => void stop(def.type)}
          onSettings={() => selectServer(def.type)}
        />
      ))}
    </div>
  );
}
