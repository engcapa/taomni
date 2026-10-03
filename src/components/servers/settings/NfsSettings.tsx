import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { CheckboxField, FieldNote, PathField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * NFS export form. NFS binds privileged ports and registers an export, so it
 * notes that OS privileges are required. Exposes the shared directory and a
 * read-only toggle.
 */
export function NfsSettings({ config, onChange }: Props) {
  const t = useT();
  const rootDir = typeof config.rootDir === "string" ? config.rootDir : "";
  const readOnly = config.readOnly === true;

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
        label={t("servers.fields.readOnly")}
        checkboxLabel={t("servers.fields.readOnly")}
        value={readOnly}
        onChange={(v) => onChange({ readOnly: v })}
      />

      <FieldNote tone="warning">{t("servers.notes.nfsPrivileges")}</FieldNote>
    </div>
  );
}
