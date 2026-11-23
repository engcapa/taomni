import type { ComponentType } from "react";
import type { ServerType } from "../../../../src/lib/servers";
import type { ServerSettingsInput } from "../../../../src/lib/servers/rendererContract";
import { CronSettings } from "./CronSettings";
import { FtpSettings } from "./FtpSettings";
import { HttpSettings } from "./HttpSettings";
import { IperfSettings } from "./IperfSettings";
import { NfsSettings } from "./NfsSettings";
import { SshSettings } from "./SshSettings";
import { TelnetSettings } from "./TelnetSettings";
import { TftpSettings } from "./TftpSettings";

const forms: Partial<Record<ServerType, ComponentType<Omit<ServerSettingsInput, "serverType">>>> = {
  cron: CronSettings,
  ftp: FtpSettings,
  http: HttpSettings,
  iperf: IperfSettings,
  nfs: NfsSettings,
  ssh: SshSettings,
  telnet: TelnetSettings,
  tftp: TftpSettings,
};

export default function LocalServerSettings({ serverType, config, onChange }: ServerSettingsInput) {
  const Form = forms[serverType];
  return Form ? <Form config={config} onChange={onChange} /> : null;
}
