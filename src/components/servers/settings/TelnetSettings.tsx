import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { FieldNote, TextField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * Telnet server form. Telnet is unencrypted, so it leads with a security
 * warning. Keeps the field set minimal: an allow-list of users and an optional
 * shell override.
 */
export function TelnetSettings({ config, onChange }: Props) {
  const t = useT();
  const allowedUsers = typeof config.allowedUsers === "string" ? config.allowedUsers : "";
  const shell = typeof config.shell === "string" ? config.shell : "";

  return (
    <div className="flex flex-col">
      <FieldNote tone="warning">{t("servers.notes.telnetSecurity")}</FieldNote>

      <TextField
        label={t("servers.fields.allowedUsers")}
        value={allowedUsers}
        placeholder="alice, bob"
        onChange={(v) => onChange({ allowedUsers: v })}
      />

      <TextField
        label={t("servers.fields.shell")}
        value={shell}
        placeholder="/bin/bash"
        onChange={(v) => onChange({ shell: v })}
      />
    </div>
  );
}
