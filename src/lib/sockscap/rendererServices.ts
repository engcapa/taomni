import { useAppStore } from "../../stores/appStore";
import type { SocksCapTerminalLaunchInfo } from "../../types";

export function openSocksCapTerminal(name: string | undefined, launch: Omit<SocksCapTerminalLaunchInfo, "terminalSessionId">): void {
  const id = `sockscap-terminal-${crypto.randomUUID()}`;
  useAppStore.getState().addTab({
    id,
    type: "terminal",
    title: name || launch.path.split(/[/\\]/).pop() || launch.path,
    closable: true,
    sockscapTerminal: { ...launch, terminalSessionId: id },
    terminalTitleMode: "manual",
  });
}
