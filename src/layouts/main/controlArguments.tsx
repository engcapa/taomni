import type { LocalShellSelection } from "../../types";


export function controlArgRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}


export function controlString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}


export function controlStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}


export function normalizeControlShellType(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}


export function controlLocalShellSelection(args: Record<string, unknown>): {
  localShell?: LocalShellSelection;
  error?: string;
} {
  const nested = controlArgRecord(args.local_shell) ?? controlArgRecord(args.localShell);
  const shellType = controlString(nested?.type)
    ?? controlString(nested?.shell)
    ?? controlString(args.shell)
    ?? controlString(args.shell_type);
  const shellPath = controlString(nested?.path) ?? controlString(args.shell_path);
  const shellArgs = controlStringArray(nested?.args) ?? controlStringArray(args.shell_args);
  const shellName = controlString(nested?.name) ?? controlString(args.shell_name);

  if (!shellType && !shellPath && !shellArgs && !shellName) return {};
  const type = normalizeControlShellType(shellType ?? (shellPath ? "custom" : "default"));
  const withArgs = (id: string, name: string): LocalShellSelection => ({
    id,
    name: shellName ?? name,
    ...(shellArgs ? { args: shellArgs } : {}),
  });

  switch (type) {
    case "default":
      if (shellArgs) return { error: "local_shell.args requires local_shell.type or local_shell.path" };
      return {};
    case "cmd":
    case "cmd.exe":
    case "command-prompt":
      return { localShell: withArgs("command-prompt", "Command Prompt") };
    case "powershell":
    case "powershell7":
    case "pwsh":
    case "ps7":
      return { localShell: withArgs("powershell", "PowerShell") };
    case "windows-powershell":
    case "windows-powershell5":
    case "powershell5":
      return { localShell: withArgs("windows-powershell", "Windows PowerShell") };
    case "git-bash":
    case "gitbash":
      return { localShell: withArgs("git-bash", "Git Bash") };
    case "wsl":
    case "wsl.exe":
      return { localShell: withArgs("wsl.exe", "WSL") };
    case "bash":
    case "zsh":
    case "sh":
      return { localShell: withArgs(type, type) };
    case "custom":
      if (!shellPath) return { error: "local_shell.type=custom requires local_shell.path" };
      return { localShell: withArgs(shellPath, shellPath) };
    default:
      return {
        error: `unsupported local_shell.type: ${shellType ?? shellPath ?? ""}`,
      };
  }
}
