import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { PathField, TextField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/** Cron server form: schedule expression, command, and working directory. */
export function CronSettings({ config, onChange }: Props) {
  const t = useT();
  const cronExpr = typeof config.cronExpr === "string" ? config.cronExpr : "";
  const command = typeof config.command === "string" ? config.command : "";
  const workingDir = typeof config.workingDir === "string" ? config.workingDir : "";

  return (
    <div className="flex flex-col">
      <TextField
        label={t("servers.fields.cronExpr")}
        value={cronExpr}
        placeholder="*/5 * * * *"
        onChange={(v) => onChange({ cronExpr: v })}
      />
      <TextField
        label={t("servers.fields.command")}
        value={command}
        placeholder="/usr/bin/backup.sh"
        onChange={(v) => onChange({ command: v })}
      />
      <PathField
        label={t("servers.fields.workingDir")}
        value={workingDir}
        mode="folder"
        browseLabel={t("servers.fields.browse")}
        onChange={(v) => onChange({ workingDir: v })}
      />
    </div>
  );
}
