import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { FieldNote, NumberField, RadioField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * iperf throughput server form. Selects the transport protocol and an optional
 * per-client bandwidth limit (0 = unlimited).
 */
export function IperfSettings({ config, onChange }: Props) {
  const t = useT();
  const protocol = config.protocol === "udp" ? "udp" : "tcp";
  const bandwidthLimit =
    typeof config.bandwidthLimit === "number" ? config.bandwidthLimit : 0;

  return (
    <div className="flex flex-col">
      <RadioField
        label={t("servers.fields.protocol")}
        name="iperf-protocol"
        value={protocol}
        onChange={(v) => onChange({ protocol: v })}
        options={[
          { value: "tcp", label: t("servers.fields.protocolTcp") },
          { value: "udp", label: t("servers.fields.protocolUdp") },
        ]}
      />

      <NumberField
        label={t("servers.fields.bandwidthLimit")}
        value={bandwidthLimit}
        min={0}
        onChange={(v) => onChange({ bandwidthLimit: v })}
      />

      <FieldNote>{t("servers.notes.iperfBandwidth")}</FieldNote>
    </div>
  );
}
