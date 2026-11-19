import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Tab } from "../../types";
import { isLegacyPluginTab, LegacyPluginTabPane } from "./LegacyPluginTabPane";

const callbacks = {
  onOpenSettings: () => undefined,
  onClose: () => undefined,
  onStatusMessage: () => undefined,
  onPersistVncProperties: async () => undefined,
  onRememberVncCredentials: async () => undefined,
  onDetachVnc: () => undefined,
  onDetachRdp: () => undefined,
  unifiedMailAccounts: [],
  onOpenMailAccount: () => undefined,
  onEditMailSession: () => undefined,
};

describe("legacy module tab adapter", () => {
  it("recognizes persisted module-owned tab kinds while leaving core tabs alone", () => {
    expect(isLegacyPluginTab({ id: "mfa", type: "mfa", title: "MFA", closable: true })).toBe(true);
    expect(isLegacyPluginTab({ id: "mail", type: "mail", title: "Mail", closable: true })).toBe(true);
    expect(isLegacyPluginTab({ id: "module", type: "plugin", title: "Module", closable: true })).toBe(false);
  });

  it("shows a contained placeholder when a restored remote tab has no payload", () => {
    const tab: Tab = { id: "rdp-missing", type: "rdp", title: "Saved RDP", closable: true };
    render(<LegacyPluginTabPane tab={tab} active {...callbacks} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Saved RDP");
  });
});
