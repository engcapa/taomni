import { useState } from "react";
import { sockscapOpenWindow, sockscapStatus, type EngineStatus } from "../../lib/sockscap";
import { useT } from "../../lib/i18n";

/**
 * Settings entry for Sockscap — opens the independent window.
 * Product name is Sockscap; search keywords cover 流量路由 / 进程代理 / 上游代理.
 */
export function SockscapSettingsPanel() {
  const t = useT();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await sockscapStatus();
      setStatus(s);
      await sockscapOpenWindow();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="sockscap-settings">
      <div className="mb-2 text-sm font-semibold">
        {t("settings.sockscapTitle")}
      </div>
      <p className="mb-3 text-xs text-[var(--taomni-muted)]">
        {t("settings.sockscapSubtitle")}
      </p>
      <p className="mb-3 text-[11px] text-[var(--taomni-muted)]">
        关键词 / keywords: 流量路由 · 进程代理 · 上游代理 · Sockscap
      </p>
      {status && (
        <p className="mb-2 text-xs">
          Status: <span data-testid="sockscap-settings-state">{status.state}</span>
        </p>
      )}
      {error && (
        <p className="mb-2 text-xs text-red-400" data-testid="sockscap-settings-error">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void open()}
        className="rounded bg-[var(--taomni-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        data-testid="sockscap-open-window"
      >
        {busy ? "…" : t("settings.sockscapOpen")}
      </button>
    </div>
  );
}
