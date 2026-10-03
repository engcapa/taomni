import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { CheckboxField, PathField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/** HTTP static-file server form: web root, directory listing, CORS headers. */
export function HttpSettings({ config, onChange }: Props) {
  const t = useT();
  const rootDir = typeof config.rootDir === "string" ? config.rootDir : "";
  const directoryListing = config.directoryListing !== false;
  const cors = config.cors === true;

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
        label={t("servers.fields.directoryListing")}
        checkboxLabel={t("servers.fields.directoryListing")}
        value={directoryListing}
        onChange={(v) => onChange({ directoryListing: v })}
      />
      <CheckboxField
        label={t("servers.fields.cors")}
        checkboxLabel={t("servers.fields.cors")}
        value={cors}
        onChange={(v) => onChange({ cors: v })}
      />
    </div>
  );
}
