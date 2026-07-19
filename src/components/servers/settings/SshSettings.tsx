import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { PasswordField, PathField, SelectField, TextField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * SSH / SFTP server form. The auth method drives which credential field is
 * shown: "OS credentials" exposes a server password (matched against the
 * configured value — not PAM / system accounts), "Key file" exposes the
 * authorized public-key file path (read at server start).
 */
export function SshSettings({ config, onChange }: Props) {
  const t = useT();
  const authMethod = config.authMethod === "key" ? "key" : "os";
  const allowedUsers = typeof config.allowedUsers === "string" ? config.allowedUsers : "";
  const rootDir = typeof config.rootDir === "string" ? config.rootDir : "";
  const password = typeof config.password === "string" ? config.password : "";
  const authorizedKeyPath =
    typeof config.authorizedKeyPath === "string" ? config.authorizedKeyPath : "";

  return (
    <div className="flex flex-col">
      <SelectField
        label={t("servers.fields.authMethod")}
        value={authMethod}
        onChange={(v) => onChange({ authMethod: v })}
        options={[
          { value: "os", label: t("servers.fields.authMethodOs") },
          { value: "key", label: t("servers.fields.authMethodKey") },
        ]}
      />

      {authMethod === "os" ? (
        <PasswordField
          label={t("servers.fields.password")}
          value={password}
          onChange={(v) => onChange({ password: v })}
        />
      ) : (
        <PathField
          label={t("servers.fields.authorizedKeyPath")}
          value={authorizedKeyPath}
          mode="file"
          browseLabel={t("servers.fields.browse")}
          onChange={(v) => onChange({ authorizedKeyPath: v })}
        />
      )}

      <TextField
        label={t("servers.fields.allowedUsers")}
        value={allowedUsers}
        placeholder="alice, bob"
        onChange={(v) => onChange({ allowedUsers: v })}
      />

      <PathField
        label={t("servers.fields.sftpRootDir")}
        value={rootDir}
        mode="folder"
        browseLabel={t("servers.fields.browse")}
        onChange={(v) => onChange({ rootDir: v })}
      />
    </div>
  );
}
