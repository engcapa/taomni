import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { CheckboxField, FieldNote, PasswordField, SelectField, TextField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * RDP server form: NLA credentials, security mode, and view-only toggle. The
 * server shares this machine's desktop with RDP clients (mstsc / FreeRDP).
 */
export function RdpSettings({ config, onChange }: Props) {
  const t = useT();
  const username = typeof config.username === "string" ? config.username : "";
  const password = typeof config.password === "string" ? config.password : "";
  const domain = typeof config.domain === "string" ? config.domain : "";
  const securityMode =
    typeof config.securityMode === "string" ? config.securityMode : "hybrid";
  const viewOnly = config.viewOnly === true;

  return (
    <div className="flex flex-col">
      <TextField
        label={t("servers.fields.rdpUsername")}
        value={username}
        onChange={(v) => onChange({ username: v })}
      />
      <PasswordField
        label={t("servers.fields.password")}
        value={password}
        onChange={(v) => onChange({ password: v })}
      />
      <TextField
        label={t("servers.fields.rdpDomain")}
        value={domain}
        onChange={(v) => onChange({ domain: v })}
        placeholder={t("servers.fields.optional")}
      />
      <SelectField
        label={t("servers.fields.rdpSecurity")}
        value={securityMode}
        onChange={(v) => onChange({ securityMode: v })}
        options={[
          { value: "hybrid", label: t("servers.fields.rdpSecHybrid") },
          { value: "tls", label: t("servers.fields.rdpSecTls") },
          { value: "none", label: t("servers.fields.rdpSecNone") },
        ]}
        width={220}
      />
      {securityMode === "none" ? (
        <FieldNote tone="warning">{t("servers.notes.rdpInsecure")}</FieldNote>
      ) : (
        <FieldNote>{t("servers.notes.rdpSelfSigned")}</FieldNote>
      )}
      <CheckboxField
        label={t("servers.fields.viewOnly")}
        checkboxLabel={t("servers.fields.viewOnly")}
        value={viewOnly}
        onChange={(v) => onChange({ viewOnly: v })}
      />
    </div>
  );
}
