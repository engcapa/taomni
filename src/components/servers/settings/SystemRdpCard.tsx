import { useCallback, useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import {
  openSystemRdpSettings,
  probeSystemRdp,
  type ServerConfig,
  type SystemRdpStatus,
} from "../../../lib/servers";
import { FieldNote, FormRow } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * Windows built-in Remote Desktop status (design §4.1). Rendered only when the
 * backend reports the check as applicable; it explains whether the system can
 * host Remote Desktop, recommends it when it is available and shows the
 * remembered "use Taomni" choice with a way to reset it. It never changes the
 * system configuration; "Open system settings" only opens the OS page.
 */
export function SystemRdpCard({ config, onChange }: Props) {
  const t = useT();
  const [status, setStatus] = useState<SystemRdpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setStatus(await probeSystemRdp());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!loading && !error && !status?.applicable) return null;

  const recommendation = status?.recommendation ?? "unknown";
  const port = status?.port ?? 3389;
  const message = (() => {
    if (loading) return t("servers.systemRdp.checking");
    if (error) return t("servers.systemRdp.probeFailed", { error });
    switch (recommendation) {
      case "use-system":
        return t("servers.systemRdp.stateRunning", {
          port,
          nla: status?.nla === false ? t("servers.systemRdp.nlaOff") : t("servers.systemRdp.nlaOn"),
        });
      case "enable-system":
        return t("servers.systemRdp.stateCanEnable");
      case "needs-admin":
        return t("servers.systemRdp.stateNeedsAdmin");
      case "taomni":
        return t("servers.systemRdp.stateUnsupported", { edition: status?.edition ?? "Windows" });
      default:
        return t("servers.systemRdp.probeFailed", { error: (status?.errors ?? []).join("; ") || "?" });
    }
  })();
  const chosen = config.systemRdpChoice === "taomni";

  return (
    <div
      data-testid="rdp-system-card"
      data-state={loading ? "loading" : error ? "error" : recommendation}
      className="flex flex-col mb-1.5"
    >
      <FormRow label={t("servers.systemRdp.title")}>
        <span className="text-[11px]" data-testid="rdp-system-message">
          {message}
        </span>
      </FormRow>
      <FormRow label="">
        {recommendation === "enable-system" ? (
          <button
            type="button"
            className="taomni-btn"
            data-testid="rdp-system-open-settings"
            onClick={() => {
              void openSystemRdpSettings().catch((err) => setError(String(err)));
            }}
          >
            {t("servers.systemRdp.openSettingsAction")}
          </button>
        ) : null}
        <button
          type="button"
          className="taomni-btn"
          data-testid="rdp-system-refresh"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {t("servers.systemRdp.refresh")}
        </button>
      </FormRow>
      {chosen ? (
        <FormRow label="">
          <span className="text-[11px]" data-testid="rdp-system-choice">
            {t("servers.systemRdp.choiceTaomni")}
          </span>
          <button
            type="button"
            className="taomni-btn"
            data-testid="rdp-system-choice-reset"
            onClick={() => onChange({ systemRdpChoice: undefined })}
          >
            {t("servers.systemRdp.choiceReset")}
          </button>
        </FormRow>
      ) : null}
      {recommendation === "use-system" && !chosen ? (
        <FieldNote>{t("servers.systemRdp.recommendSystem")}</FieldNote>
      ) : null}
      <FieldNote tone="warning">{t("servers.systemRdp.secureDesktopNote")}</FieldNote>
    </div>
  );
}
