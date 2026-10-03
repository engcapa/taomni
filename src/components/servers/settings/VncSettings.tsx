import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { CheckboxField, PasswordField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/** VNC server form: access password, view-only mode, shared-desktop toggle. */
export function VncSettings({ config, onChange }: Props) {
  const t = useT();
  const password = typeof config.password === "string" ? config.password : "";
  const viewOnly = config.viewOnly === true;
  const sharedDesktop = config.sharedDesktop !== false;

  return (
    <div className="flex flex-col">
      <PasswordField
        label={t("servers.fields.password")}
        value={password}
        onChange={(v) => onChange({ password: v })}
      />
      <CheckboxField
        label={t("servers.fields.viewOnly")}
        checkboxLabel={t("servers.fields.viewOnly")}
        value={viewOnly}
        onChange={(v) => onChange({ viewOnly: v })}
      />
      <CheckboxField
        label={t("servers.fields.sharedDesktop")}
        checkboxLabel={t("servers.fields.sharedDesktop")}
        value={sharedDesktop}
        onChange={(v) => onChange({ sharedDesktop: v })}
      />
    </div>
  );
}
