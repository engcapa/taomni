import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import {
  CheckboxField,
  FieldNote,
  NumberField,
  PasswordField,
  PathField,
  SelectField,
  TextField,
} from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * SSH / SFTP server form.
 *
 * Auth modes:
 * - password: configured password (not PAM / OS accounts)
 * - key: authorized public-key file (multi-line authorized_keys supported)
 * - both: password and key file fields together
 */
export function SshSettings({ config, onChange }: Props) {
  const t = useT();
  const authMethod =
    config.authMethod === "key" || config.authMethod === "both"
      ? (config.authMethod as string)
      : "password";
  const allowedUsers = typeof config.allowedUsers === "string" ? config.allowedUsers : "";
  const rootDir = typeof config.rootDir === "string" ? config.rootDir : "";
  const password = typeof config.password === "string" ? config.password : "";
  const authorizedKeyPath =
    typeof config.authorizedKeyPath === "string" ? config.authorizedKeyPath : "";
  const loginShell = config.loginShell !== false;
  const maxSessions =
    typeof config.maxSessions === "number" && Number.isFinite(config.maxSessions)
      ? Math.max(1, Math.min(256, Math.floor(config.maxSessions as number)))
      : 8;

  const showPassword = authMethod === "password" || authMethod === "both";
  const showKey = authMethod === "key" || authMethod === "both";

  return (
    <div className="flex flex-col">
      <SelectField
        label={t("servers.fields.authMethod")}
        value={authMethod}
        onChange={(v) => onChange({ authMethod: v })}
        options={[
          { value: "password", label: t("servers.fields.authMethodPassword") },
          { value: "key", label: t("servers.fields.authMethodKey") },
          { value: "both", label: t("servers.fields.authMethodBoth") },
        ]}
      />

      {showPassword ? (
        <PasswordField
          label={t("servers.fields.password")}
          value={password}
          onChange={(v) => onChange({ password: v })}
        />
      ) : null}

      {showKey ? (
        <PathField
          label={t("servers.fields.authorizedKeyPath")}
          value={authorizedKeyPath}
          mode="file"
          browseLabel={t("servers.fields.browse")}
          onChange={(v) => onChange({ authorizedKeyPath: v })}
        />
      ) : null}

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

      <CheckboxField
        label={t("servers.fields.loginShell")}
        checkboxLabel={t("servers.fields.loginShell")}
        value={loginShell}
        onChange={(v) => onChange({ loginShell: v })}
      />

      <NumberField
        label={t("servers.fields.maxSessions")}
        value={maxSessions}
        min={1}
        max={256}
        onChange={(v) => onChange({ maxSessions: v })}
      />

      <FieldNote>{t("servers.notes.sshAuthHint")}</FieldNote>
      <FieldNote>{t("servers.notes.sshPortForward")}</FieldNote>
    </div>
  );
}
