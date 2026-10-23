/** Stable values also accept labels saved by earlier localized editors. */
export function remoteEnvironment(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (/^LXDE|^lxde/.test(text)) return "lxde";
  if (/^Xfce|^xfce/.test(text)) return "xfce";
  if (/^GNOME|^gnome/.test(text)) return "gnome";
  if (/^KDE|^kde/.test(text)) return "kde";
  if (/^Awesome|^awesome/.test(text)) return "awesome";
  if (/^Custom|^自定义|^custom/.test(text)) return "custom";
  return "shell";
}

export function sshBrowserMode(value: unknown): "sftp" | "scp-fast" | "scp" | "disabled" {
  if (value === "Disabled" || value === "停用" || value === "disabled") return "disabled";
  if (value === "scp-fast" || value === "SCP (enhanced speed)" || value === "SCP（高速模式）") return "scp-fast";
  if (value === "scp" || value === "SCP (compatibility)" || value === "SCP（兼容模式）") return "scp";
  return "sftp";
}

export function sshStartupCommand(options: Record<string, unknown>): string {
  const command = typeof options.startupCmd === "string" ? options.startupCmd.trim() : "";
  const environment = remoteEnvironment(options.remoteEnv);
  if (environment === "shell" || environment === "custom") return command;
  const launch: Record<string, string> = {
    lxde: "if command -v startlxqt >/dev/null 2>&1; then startlxqt; else startlxde; fi",
    xfce: "startxfce4", gnome: "gnome-session", kde: "startplasma-x11", awesome: "awesome",
  };
  // A desktop session is an X11 client on the SSH-forwarded display. Fail
  // visibly on a missing display or executable; never launch it locally.
  return `if [ -z "\$DISPLAY" ]; then printf '%s\\n' 'Remote desktop requires X11 forwarding'; else ${command ? `${command}; ` : ""}${launch[environment]}; fi`;
}
