import { useT } from "../../../../src/lib/i18n";
import type { ServerConfig } from "../../../../src/lib/servers";
import { CheckboxField, NumberField, PathField } from "../../../../src/components/servers/fields";
import { LocalServerPassword } from "./LocalServerPassword";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/** FTP server form: served root directory, anonymous access, connection cap. */
export function FtpSettings({ config, onChange }: Props) {
  const t = useT();
  const rootDir = typeof config.rootDir === "string" ? config.rootDir : "";
  const allowAnonymous = config.allowAnonymous === true;
  const maxConnections = typeof config.maxConnections === "number" ? config.maxConnections : 10;

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
        label={t("servers.fields.allowAnonymous")}
        checkboxLabel={t("servers.fields.allowAnonymous")}
        value={allowAnonymous}
        onChange={(v) => onChange({ allowAnonymous: v })}
      />
      <LocalServerPassword type="ftp" config={config} onChange={onChange} />
      <NumberField
        label={t("servers.fields.maxConnections")}
        value={maxConnections}
        min={1}
        onChange={(v) => onChange({ maxConnections: v })}
      />
    </div>
  );
}
