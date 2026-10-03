import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { CheckboxField, PathField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/** TFTP server form: served root directory and an upload (writable) toggle. */
export function TftpSettings({ config, onChange }: Props) {
  const t = useT();
  const rootDir = typeof config.rootDir === "string" ? config.rootDir : "";
  const writable = config.writable === true;

  return (
    <div className="flex flex-col">
      <PathField
        label={t("servers.fields.rootDir")}
        value={rootDir}
        mode="folder"
        browseLabel={t("servers.fields.browse")}
        onChange={(v) => onChange({ rootDir: v })}
      />
      <CheckboxField
        label={t("servers.fields.writable")}
        checkboxLabel={t("servers.fields.writable")}
        value={writable}
        onChange={(v) => onChange({ writable: v })}
      />
    </div>
  );
}
