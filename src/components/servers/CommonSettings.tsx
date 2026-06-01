import { useT } from "../../lib/i18n";
import type { ServerConfig, ServerDef } from "../../lib/servers";
import { CheckboxField, FormRow, NumberField, TextField } from "./fields";

interface Props {
  def: ServerDef;
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * Shared fields rendered above every per-type form: listening port (hidden for
 * types with no port, e.g. cron), bind address, auto-stop toggle + seconds, and
 * the start-on-launch toggle.
 */
export function CommonSettings({ def, config, onChange }: Props) {
  const t = useT();

  return (
    <div className="flex flex-col">
      {def.hasPort && (
        <NumberField
          label={t("servers.fields.port")}
          value={config.port}
          min={0}
          max={65535}
          onChange={(port) => onChange({ port })}
        />
      )}

      <TextField
        label={t("servers.fields.bindAddress")}
        value={config.bindAddress}
        placeholder="0.0.0.0"
        onChange={(bindAddress) => onChange({ bindAddress })}
      />

      <CheckboxField
        label={t("servers.fields.autoStop")}
        checkboxLabel={t("servers.fields.autoStopSeconds")}
        value={config.autoStop}
        onChange={(autoStop) => onChange({ autoStop })}
      />

      {config.autoStop && (
        <FormRow label="">
          <input
            type="number"
            className="taomni-input"
            style={{ width: 90 }}
            min={1}
            value={Number.isFinite(config.autoStopSeconds) ? config.autoStopSeconds : ""}
            onChange={(e) => {
              const parsed = parseInt(e.target.value || "0", 10);
              onChange({ autoStopSeconds: Number.isNaN(parsed) ? 0 : parsed });
            }}
          />
          <span className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
            {t("servers.fields.autoStopSeconds")}
          </span>
        </FormRow>
      )}

      <CheckboxField
        label={t("servers.fields.startOnLaunch")}
        checkboxLabel={t("servers.fields.startOnLaunch")}
        value={config.startOnLaunch}
        onChange={(startOnLaunch) => onChange({ startOnLaunch })}
      />
    </div>
  );
}
