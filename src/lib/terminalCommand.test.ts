import { describe, expect, it } from "vitest";
import { extractTerminalCommand } from "./terminalCommand";

describe("extractTerminalCommand", () => {
  it.each([
    "[user@host ~]$ ",
    "root@host:/srv# ",
    "fish@host /tmp% ",
    "PS C:\\Users\\me> ",
  ])("recognizes an idle standard prompt: %s", (text) => {
    expect(extractTerminalCommand(text)).toBe("");
  });

  it.each([
    ["[user@host ~]$ ls -la", "ls -la"],
    ["root@host:/srv# systemctl status sshd", "systemctl status sshd"],
    ["PS C:\\Users\\me> Get-Location", "Get-Location"],
  ])("extracts a typed command from %s", (text, expected) => {
    expect(extractTerminalCommand(text)).toBe(expected);
  });

  it.each([
    "[user@host ~]$ echo $ ",
    "[user@host ~]$ printf foo > ",
    "[user@host ~]$ echo 100% ",
    "[user@host ~]$ echo foo # ",
  ])("does not mistake prompt-like command text for an idle prompt: %s", (text) => {
    expect(extractTerminalCommand(text)).not.toBe("");
  });

  it("fails safe when the prompt has no separating space", () => {
    expect(extractTerminalCommand("[user@host ~]$")).toBe("[user@host ~]$");
  });

  it("trims a wrapped command assembled from multiple buffer rows", () => {
    expect(extractTerminalCommand("[user@host ~]$ printf '%s' \\\nvalue   ")).toBe("printf '%s' \\\nvalue");
  });
});
