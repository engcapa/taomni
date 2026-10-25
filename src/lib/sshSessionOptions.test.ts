import { expect, it } from "vitest";
import { remoteEnvironment, sshBrowserMode, sshStartupCommand } from "./sshSessionOptions";
it("normalizes historical localized options and stable values", () => {
  expect(remoteEnvironment("交互式 Shell")).toBe("shell");
  expect(remoteEnvironment("GNOME 桌面")).toBe("gnome");
  expect(remoteEnvironment("自定义命令…")).toBe("custom");
  expect(sshBrowserMode("停用")).toBe("disabled");
  expect(sshBrowserMode("SCP（兼容模式）")).toBe("scp");
  expect(sshBrowserMode("scp-fast")).toBe("scp-fast");
});
it("launches selected remote desktops on forwarded DISPLAY and preserves explicit commands", () => {
  expect(sshStartupCommand({ startupCmd: " tmux ", remoteEnv: "shell" })).toBe("tmux");
  expect(sshStartupCommand({ startupCmd: "custom-session", remoteEnv: "custom" })).toBe("custom-session");
  expect(sshStartupCommand({ remoteEnv: "xfce" })).toContain("$DISPLAY");
  expect(sshStartupCommand({ remoteEnv: "xfce" })).toContain("startxfce4");
  expect(sshStartupCommand({ remoteEnv: "gnome", startupCmd: "export QA=1" })).toContain("export QA=1; gnome-session");
});
