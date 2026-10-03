/**
 * Local shell launch options persisted under `SessionConfig.options_json` for
 * `SessionType::LocalShell` sessions. The frontend passes these through the
 * existing `create_local_terminal` IPC as an executable path plus argv.
 */
export interface LocalShellOptions {
  shellPath: string;
  shellArgsText: string;
}

export const DEFAULT_LOCAL_SHELL_OPTIONS: LocalShellOptions = {
  shellPath: "",
  shellArgsText: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

export function parseLocalShellOptions(optionsJson: string | null | undefined): LocalShellOptions {
  if (!optionsJson) return { ...DEFAULT_LOCAL_SHELL_OPTIONS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return { ...DEFAULT_LOCAL_SHELL_OPTIONS };
  }
  if (!isRecord(parsed)) return { ...DEFAULT_LOCAL_SHELL_OPTIONS };

  const args = Array.isArray(parsed.localShellArgs)
    ? parsed.localShellArgs.filter((item): item is string => typeof item === "string")
    : [];

  return {
    shellPath: readString(parsed, "localShellPath"),
    shellArgsText: shellArgsToText(args),
  };
}

export function serializeLocalShellOptions(options: LocalShellOptions): Record<string, unknown> {
  const shellPath = options.shellPath.trim();
  if (!shellPath) return {};

  const args = parseLocalShellArgsText(options.shellArgsText);
  return {
    localShellPath: shellPath,
    ...(args.length > 0 ? { localShellArgs: args } : {}),
  };
}

export function parseLocalShellArgsText(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  let tokenStarted = false;

  const push = () => {
    if (!tokenStarted) return;
    args.push(current);
    current = "";
    tokenStarted = false;
  };

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (quote) {
      if (quote === "\"" && char === "\\") {
        escaping = true;
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      push();
    } else {
      current += char;
      tokenStarted = true;
    }
  }

  if (escaping) {
    current += "\\";
    tokenStarted = true;
  }
  push();
  return args;
}

export function shellArgsToText(args: readonly string[]): string {
  return args.map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (arg.length === 0) return "\"\"";
  if (!/[\s"']/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
