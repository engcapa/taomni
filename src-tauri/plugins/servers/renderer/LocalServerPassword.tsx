import { useT } from "../../../../src/lib/i18n";
import type { ServerConfig } from "../../../../src/lib/servers";
import { CheckboxField, PasswordField } from "../../../../src/components/servers/fields";

interface Props {
  type: "ssh" | "ftp";
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

export function LocalServerPassword({ type, config, onChange }: Props) {
  const t = useT();
  const password = typeof config.password === "string" ? config.password : "";
  const saved = Boolean(config.passwordRef) || config.credentialMigrationRequired === true;
  return (
    <>
      <PasswordField
        label={t("servers.fields.password")}
        testId={`server-field-${type}-password`}
        placeholder={saved && config.removePassword !== true
          ? t("servers.fields.localPasswordRetained")
          : undefined}
        value={password}
        onChange={(value) => onChange({ password: value, removePassword: false })}
      />
      {saved && (
        <CheckboxField
          label={t("servers.fields.localRemovePassword")}
          testId={`server-field-${type}-remove-password`}
          value={config.removePassword === true}
          onChange={(removePassword) => onChange({ removePassword, password: "" })}
        />
      )}
    </>
  );
}
