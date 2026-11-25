import { describe, expect, it } from "vitest";
import {
  ModuleStoreError,
  createModuleStoreState,
  reduceModuleStore,
  transitionModule,
} from "./moduleStore";

describe("module installation state machine", () => {
  it("installs, enables, disables, and persists an explicit lifecycle projection", () => {
    let state = createModuleStoreState();
    state = reduceModuleStore(state, "rdp-client", { type: "install", version: "1.2.3" });
    expect(state.records["rdp-client"]).toMatchObject({ lifecycle: "installed", activeVersion: "1.2.3" });
    state = reduceModuleStore(state, "rdp-client", { type: "enable" });
    state = reduceModuleStore(state, "rdp-client", { type: "disable" });
    expect(state.records["rdp-client"].lifecycle).toBe("disabled");
    expect(state.revision).toBe(3);
  });

  it("retains data on uninstall and allows an explicit data deletion", () => {
    const installed = transitionModule(undefined, "mfa", { type: "install", version: "1.0.0" });
    const retained = transitionModule(installed, "mfa", { type: "uninstall" });
    expect(retained).toMatchObject({ lifecycle: "uninstalled", dataRetained: true, activeVersion: undefined });
    const deleted = transitionModule(installed, "mfa", { type: "uninstall", deleteData: true });
    expect(deleted.dataRetained).toBe(false);
  });

  it("switches active version through rollback and keeps a return point", () => {
    const installed = transitionModule(undefined, "vnc-client", { type: "install", version: "2.0.0" });
    const upgraded = transitionModule(installed, "vnc-client", { type: "install", version: "2.1.0" });
    const rolling = transitionModule(upgraded, "vnc-client", { type: "begin-rollback" });
    expect(rolling.lifecycle).toBe("rollback");
    const rolled = transitionModule(rolling, "vnc-client", { type: "complete-rollback", version: "2.0.0" });
    expect(rolled).toMatchObject({ lifecycle: "disabled", version: "2.0.0", activeVersion: "2.0.0", previousVersion: "2.1.0" });
  });

  it("rejects unsafe transitions and versions", () => {
    expect(() => transitionModule(undefined, "../escape", { type: "install", version: "1.0.0" })).toThrow(ModuleStoreError);
    expect(() => transitionModule(undefined, "mfa", { type: "install", version: "latest" })).toThrow("Invalid module version");
    expect(() => transitionModule(undefined, "mfa", { type: "enable" })).toThrow("not installed");
    const first = transitionModule(undefined, "mfa", { type: "install", version: "1.0.0" });
    expect(() => transitionModule(first, "mfa", { type: "begin-rollback" })).toThrow("no rollback version");
    const upgraded = transitionModule(first, "mfa", { type: "install", version: "1.1.0" });
    const rolling = transitionModule(upgraded, "mfa", { type: "begin-rollback" });
    expect(() => transitionModule(rolling, "mfa", { type: "complete-rollback", version: "9.9.9" })).toThrow("rollback version is unavailable");
  });
});

