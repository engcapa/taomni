import { describe, expect, it } from "vitest";
import { CommandRegistry } from "./registry";

describe("browser command registry", () => {
  it("supports scoped overrides and cleanup", async () => {
    const registry = new CommandRegistry();
    const cleanup = registry.register({
      domain: "workspace",
      command: "workspace_read_file",
      handler: (args) => `fixture:${String(args?.path)}`,
    });
    await expect(registry.invoke("workspace_read_file", { path: "README.md" })).resolves.toBe("fixture:README.md");
    cleanup();
    expect(registry.has("workspace_read_file")).toBe(false);
  });
});

describe("registry ownership", () => {
  it("rejects a duplicate batch without leaving partial registrations", () => {
    const registry = new CommandRegistry();
    registry.register({ domain: "file", command: "read", handler: () => "original" });
    expect(() => registry.registerMany([
      { domain: "file", command: "write", handler: () => undefined },
      { domain: "file", command: "read", handler: () => "duplicate" },
    ])).toThrow("already registered");
    expect(registry.has("write")).toBe(false);
  });

  it("does not remove a replacement when an old owner disposes twice", async () => {
    const registry = new CommandRegistry();
    const dispose = registry.register({ domain: "file", command: "read", handler: () => "old" });
    dispose();
    registry.register({ domain: "file", command: "read", handler: () => "new" });
    dispose();
    await expect(registry.invoke("read")).resolves.toBe("new");
  });

  it("preserves omitted args, options, undefined results and failures", async () => {
    const registry = new CommandRegistry();
    const failure = new Error("read failed");
    registry.register({ domain: "file", command: "read", handler: (args, options) => {
      expect(args).toBeUndefined();
      expect(options).toEqual({ headers: { range: "bytes=0-3" } });
      throw failure;
    } });
    await expect(registry.invoke("read", undefined, { headers: { range: "bytes=0-3" } })).rejects.toBe(failure);
    registry.register({ domain: "file", command: "close", handler: () => undefined });
    await expect(registry.invoke("close")).resolves.toBeUndefined();
  });
});
