import { useEffect, useState } from "react";
import { listSessions, type SessionConfig } from "../../lib/ipc";
import { useT } from "../../lib/i18n";

interface AcpProxyPatch {
  proxy_mode?: string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
}

interface Props {
  mode?: string | null;
  sessionId?: string | null;
  proxyUrl?: string | null;
  includeInherit?: boolean;
  testIdPrefix: string;
  onChange: (patch: AcpProxyPatch) => void;
}

interface ProxySessionOption {
  id: string;
  name: string;
  host: string;
  port: number;
}

function normalizedMode(mode: string | null | undefined, includeInherit: boolean): string {
  if (mode === "direct" || mode === "app" || mode === "session" || mode === "manual") return mode;
  return includeInherit ? "inherit" : "direct";
}

export function AcpProxyFields({
  mode,
  sessionId,
  proxyUrl,
  includeInherit = false,
  testIdPrefix,
  onChange,
}: Props) {
  const t = useT();
  const [proxySessions, setProxySessions] = useState<ProxySessionOption[]>([]);
  const selectedMode = normalizedMode(mode, includeInherit);

  useEffect(() => {
    listSessions()
      .then((sessions: SessionConfig[]) => {
        setProxySessions(
          sessions
            .filter((session) => session.session_type === "Proxy")
            .map((session) => ({
              id: session.id,
              name: session.name,
              host: session.host,
              port: session.port,
            })),
        );
      })
      .catch(() => setProxySessions([]));
  }, []);

  const modes = [
    ...(includeInherit ? [{ value: "inherit", label: t("aiSettings.acpProxyInherit") }] : []),
    { value: "direct", label: t("aiSettings.acpProxyDirect") },
    { value: "app", label: t("aiSettings.acpProxyApp") },
    { value: "session", label: t("settings.appProxyModeSession") },
    { value: "manual", label: t("settings.appProxyModeManual") },
  ];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {modes.map(({ value, label }) => (
          <label key={value} className="flex items-center gap-1.5 cursor-pointer text-[11px]">
            <input
              type="radio"
              className="accent-[var(--taomni-accent)]"
              checked={selectedMode === value}
              onChange={() => onChange({ proxy_mode: value })}
              data-testid={`${testIdPrefix}-${value}`}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      {selectedMode === "session" &&
        (proxySessions.length > 0 ? (
          <select
            className="taomni-input h-7 w-full text-[12px]"
            value={sessionId ?? ""}
            onChange={(event) => onChange({ proxy_session_id: event.target.value || null })}
            data-testid={`${testIdPrefix}-session-select`}
          >
            <option value="">{t("settings.appProxySessionPlaceholder")}</option>
            {proxySessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name} ({session.host}:{session.port})
              </option>
            ))}
          </select>
        ) : (
          <div className="text-[11px] text-[var(--taomni-text-muted)]">
            {t("settings.appProxySessionNone")}
          </div>
        ))}

      {selectedMode === "manual" && (
        <input
          type="text"
          className="taomni-input h-7 w-full text-[12px] font-mono"
          placeholder="http://127.0.0.1:31028"
          defaultValue={proxyUrl ?? ""}
          onBlur={(event) => onChange({ proxy_url: event.target.value.trim() || null })}
          data-testid={`${testIdPrefix}-manual-url`}
        />
      )}
    </div>
  );
}
