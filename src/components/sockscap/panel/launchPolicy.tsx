import { type LaunchPreparation } from "../../../lib/sockscap";


export function rootlessAppKey(
  path: string,
  args: string[] | undefined,
  launchMode: "desktop" | "terminal" | undefined,
  launchPreparation: LaunchPreparation | undefined,
): string {
  return JSON.stringify([
    path,
    args ?? [],
    launchMode ?? "desktop",
    normalizeLaunchPreparation(launchPreparation),
  ]);
}


export function normalizeLaunchPreparation(
  preparation: LaunchPreparation | undefined,
): LaunchPreparation {
  const workingDirectory = preparation?.workingDirectory?.trim() ?? "";
  const preCommand = preparation?.preCommand?.trim() ?? "";
  const environment = Object.fromEntries(
    Object.entries(preparation?.environment ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const shell = preparation?.shell ?? "sh";
  return {
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
    ...(preCommand ? { preCommand } : {}),
    ...(shell === "bash" ? { shell } : {}),
  };
}


export function launchPreparationIsEmpty(preparation: LaunchPreparation): boolean {
  return Object.keys(normalizeLaunchPreparation(preparation)).length === 0;
}


export function parseShellArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let started = false;

  const finish = () => {
    if (!started) return;
    args.push(current);
    current = "";
    started = false;
  };

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = null;
      else if (char === "\\") escaped = true;
      else current += char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      finish();
    } else if (char === "'") {
      quote = "single";
      started = true;
    } else if (char === '"') {
      quote = "double";
      started = true;
    } else if (char === "\\") {
      escaped = true;
      started = true;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== null || escaped) throw new Error("unterminated shell argument");
  finish();
  return args;
}


export function formatRootlessCommand(path: string, args: string[] | undefined): string {
  return [path, ...(args ?? [])].map(quoteShellArgument).join(" ");
}


export function formatRootlessArguments(args: string[] | undefined): string {
  return (args ?? []).map(quoteShellArgument).join(" ");
}


export function quoteShellArgument(value: string): string {
  if (value && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
