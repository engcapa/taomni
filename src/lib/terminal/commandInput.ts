/**
 * Build stdin for an interactive terminal command.
 *
 * xterm sends Enter as carriage return (`\r`) to PTYs, including Windows
 * ConPTY and SSH PTYs. Treat command newlines as repeated Enter presses rather
 * than OS text-file line endings; using `\n` can leave PowerShell/PSReadLine in
 * a continuation prompt instead of submitting the command.
 */
export function buildInteractiveCommandInput(command: string): string {
  return `${command.replace(/\r\n|\r|\n/g, "\r").replace(/\r+$/g, "")}\r`;
}
