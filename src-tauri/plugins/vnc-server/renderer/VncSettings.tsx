import { useT } from "../../../../src/lib/i18n";
import type { ServerConfig } from "../../../../src/lib/servers";
import { CheckboxField, PasswordField } from "../../../../src/components/servers/fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/** VNC server form: access password, view-only mode, shared-desktop toggle. */
export default function VncSettings({ config, onChange }: Props) {
  const t = useT();
  const password = typeof config.password === "string" ? config.password : "";
  const retainedPassword = Boolean(config.passwordRef) || config.credentialMigrationRequired === true;
  const viewOnly = config.viewOnly === true;
  const sharedDesktop = config.sharedDesktop !== false;

  return (
    <div className="flex flex-col">
      <PasswordField
        label={t("servers.fields.password")}
        testId="server-field-vnc-password"
        placeholder={retainedPassword && config.removePassword !== true
          ? t("servers.fields.vncPasswordRetained")
          : undefined}
        value={password}
        onChange={(v) => onChange({ password: v, removePassword: false })}
      />
      {retainedPassword && (
        <CheckboxField
          label={t("servers.fields.vncRemovePassword")}
          testId="server-field-vnc-remove-password"
          value={config.removePassword === true}
          onChange={(removePassword) => onChange({ removePassword, password: "" })}
        />
      )}
      <CheckboxField
        label={t("servers.fields.viewOnly")}
        testId="server-field-vnc-view-only"
        checkboxLabel={t("servers.fields.viewOnly")}
        value={viewOnly}
        onChange={(v) => onChange({ viewOnly: v })}
      />
      <CheckboxField
        label={t("servers.fields.sharedDesktop")}
        testId="server-field-vnc-shared"
        checkboxLabel={t("servers.fields.sharedDesktop")}
        value={sharedDesktop}
        onChange={(v) => onChange({ sharedDesktop: v })}
      />
    </div>
  );
}
