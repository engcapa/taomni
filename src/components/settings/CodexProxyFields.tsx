import { useEffect, useState } from "react";
import { listSessions, type SessionConfig } from "../../lib/ipc";
import { useT } from "../../lib/i18n";

export type CodexProxyMode = "inherit" | "none" | "session" | "manual" | string;

interface Props {
  mode: CodexProxyMode | undefined;
  sessionId?: string | null;
  proxyUrl?: string | null;
  includeInherit?: boolean;
  onChange: (patch: { proxy_mode?: string; proxy_session_id?: string | null; proxy_url?: string | null }) => void;
}

interface ProxySessionOption {
  id: string;
  name: string;
  host: string;
  port: number;
}

function normalizeMode(mode: CodexProxyMode | undefined, includeInherit: boolean): string {
  if (mode === "session" || mode === "manual" || mode === "none") return mode;
  return includeInherit ? "inherit" : "none";
}

export function CodexProxyFields({ mode, sessionId, proxyUrl, includeInherit = false, onChange }: Props) {
  const t = useT();
  const [proxySessions, setProxySessions] = useState<ProxySessionOption[]>([]);
  const selectedMode = normalizeMode(mode, includeInherit);

  useEffect(() => {
    listSessions()
      .then((all: SessionConfig[]) => {
        setProxySessions(
          all
            .filter((s) => s.session_type === "Proxy")
            .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port })),
        );
      })
      .catch(() => setProxySessions([]));
  }, []);

  const modes = [
    ...(includeInherit ? [{ value: "inherit", label: t("aiSettings.codexProxyInherit") }] : []),
    { value: "none", label: t("aiSettings.codexProxyNone") },
    { value: "session", label: t("settings.appProxyModeSession") },
    { value: "manual", label: t("settings.appProxyModeManual") },
  ];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        {modes.map(({ value, label }) => (
          <label key={value} className="flex items-center gap-1.5 cursor-pointer text-[11px]">
            <input
              type="radio"
              className="accent-[var(--taomni-accent)]"
              checked={selectedMode === value}
              onChange={() => onChange({ proxy_mode: value })}
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
            onChange={(e) => onChange({ proxy_session_id: e.target.value || null })}
          >
            <option value="">{t("settings.appProxySessionPlaceholder")}</option>
            {proxySessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.host}:{s.port})
              </option>
            ))}
          </select>
        ) : (
          <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("settings.appProxySessionNone")}</div>
        ))}

      {selectedMode === "manual" && (
        <input
          type="text"
          className="taomni-input h-7 w-full text-[12px] font-mono"
          placeholder="http://127.0.0.1:31028"
          value={proxyUrl ?? ""}
          onChange={(e) => onChange({ proxy_url: e.target.value.trim() || null })}
        />
      )}
    </div>
  );
}
