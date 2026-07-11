export type WorkspaceCommandFocus = "workspace" | "editor" | "tree" | "terminal";

export interface WorkspaceCommandContext {
  focus: WorkspaceCommandFocus;
}

export interface WorkspaceCommand {
  id: string;
  title: string;
  category: string;
  keybinding?: string;
  keybindings?: string[];
  keywords?: string[];
  when?: (context: WorkspaceCommandContext) => boolean;
  run: (context: WorkspaceCommandContext) => void | Promise<void>;
}

interface KeyboardEventLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface ParsedKeybinding {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

function normalizeKey(value: string): string {
  const key = value.toLowerCase();
  if (key === "left") return "arrowleft";
  if (key === "right") return "arrowright";
  if (key === "up") return "arrowup";
  if (key === "down") return "arrowdown";
  return key;
}

function parseKeybinding(value: string): ParsedKeybinding | null {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));
  return {
    key: normalizeKey(parts[parts.length - 1]),
    ctrl: modifiers.has("ctrl"),
    shift: modifiers.has("shift"),
    alt: modifiers.has("alt"),
    meta: modifiers.has("meta") || modifiers.has("cmd"),
  };
}

export function workspaceCommandEnabled(
  command: WorkspaceCommand,
  context: WorkspaceCommandContext,
): boolean {
  return command.when?.(context) ?? true;
}

export function workspaceCommandMatchesKeybinding(
  command: WorkspaceCommand,
  event: Pick<KeyboardEventLike, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
): boolean {
  const bindings = [command.keybinding, ...(command.keybindings ?? [])].filter((value): value is string => !!value);
  return bindings.some((value) => {
    const binding = parseKeybinding(value);
    return !!binding
      && binding.key === normalizeKey(event.key)
      && binding.ctrl === event.ctrlKey
      && binding.shift === event.shiftKey
      && binding.alt === event.altKey
      && binding.meta === event.metaKey;
  });
}

export function dispatchWorkspaceCommandKeydown(
  commands: readonly WorkspaceCommand[],
  context: WorkspaceCommandContext,
  event: KeyboardEventLike,
): WorkspaceCommand | null {
  const command = commands.find((candidate) => (
    workspaceCommandEnabled(candidate, context)
    && workspaceCommandMatchesKeybinding(candidate, event)
  ));
  if (!command) return null;
  event.preventDefault();
  event.stopPropagation();
  void command.run(context);
  return command;
}

export function runWorkspaceCommand(
  commands: readonly WorkspaceCommand[],
  id: string,
  context: WorkspaceCommandContext,
): boolean {
  const command = commands.find((candidate) => candidate.id === id);
  if (!command || !workspaceCommandEnabled(command, context)) return false;
  void command.run(context);
  return true;
}
