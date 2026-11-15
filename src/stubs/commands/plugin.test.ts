import { describe, expect, it } from "vitest";
import { invokePlugin } from "./plugin";

describe("browser plugin boundary", () => {
  it("rejects unverified archive and directory installs while retaining an empty registry", async () => {
    for (const command of ["plugin_install_archive", "plugin_install_staged"]) {
      await expect(invokePlugin(command)).rejects.toThrow("cannot verify native signatures");
    }
    expect(await invokePlugin("plugin_list")).toEqual([]);
    expect(await invokePlugin("plugin_refresh")).toEqual([]);
  });

  it("never returns a fake success for unsupported lifecycle commands", async () => {
    await expect(invokePlugin("plugin_set_enabled")).rejects.toThrow("requires the desktop app");
    expect(await invokePlugin("plugin_cancel_request")).toBe(false);
  });
});
