import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../../../../lib/ipc/orchestration";
import { useAiStore } from "../../../../stores/aiStore";
import { useOrchestrationStore } from "../../../../stores/orchestrationStore";
import { AgentsPlatformView } from "../../AgentsPlatformView";
import { hasValidAgentSettings } from "../settingsModel";
import { resetOrchestrationHarness, runFixture, settingsFixture } from "./harness";

vi.mock("../../../../lib/ipc/orchestration");
vi.mock("../../../settings/AppProxyPanel", () => ({
  AppProxyPanel: ({ value, onSave }: { value: { host: string }; onSave: (config: unknown) => Promise<void> }) => <input data-testid="shared-proxy-host" value={value.host} onChange={(event) => { void onSave({ ...value, host: event.target.value }); }} />,
}));

beforeEach(resetOrchestrationHarness);
afterEach(cleanup);
async function openSettings() {
  render(<AgentsPlatformView />);
  await waitFor(() => expect(screen.getByTestId("orch-composer-settings")).toHaveTextContent("Daily development"));
  screen.getByTestId("orch-settings-open").focus();
  fireEvent.click(screen.getByTestId("orch-settings-open"));
  return screen.getByTestId("orch-settings-dialog");
}
function openResource() {
  fireEvent.click(screen.getByTestId("orch-settings-resources"));
  fireEvent.click(screen.getByTestId("orch-resource-api"));
}

describe("shared plan and reusable resources", () => {
  it("edits a shared plan, saves once with CAS, and leaves existing task snapshots unchanged", async () => {
    vi.mocked(ipc.listAgentRuns).mockResolvedValue([runFixture()]);
    await openSettings();
    fireEvent.change(screen.getByTestId("orch-plan-name"), { target: { value: "Team defaults" } });
    fireEvent.click(screen.getByTestId("orch-settings-save"));
    await waitFor(() => expect(screen.queryByTestId("orch-settings-dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("orch-composer-settings")).toHaveTextContent("Team defaults");
    expect(ipc.saveAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ name: "Team defaults", revision: 3 }), 3);
    expect(useOrchestrationStore.getState().runs[0].settingsSnapshot.name).toBe("Daily development");
    fireEvent.click(screen.getByTestId("orch-settings-open"));
    expect(screen.getByTestId("orch-plan-name")).toHaveValue("Team defaults");
    expect(ipc.startAgentRun).not.toHaveBeenCalled();
  });

  it("Escape discards edits and restores focus; reopening reads persisted settings", async () => {
    await openSettings();
    fireEvent.change(screen.getByTestId("orch-plan-name"), { target: { value: "Unsaved draft" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("orch-settings-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("orch-settings-open")).toHaveFocus();
    expect(ipc.saveAgentSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("orch-settings-open"));
    expect(screen.getByTestId("orch-plan-name")).toHaveValue("Daily development");
  });

  it("reuses existing AI providers and accepts only Vault credential references", async () => {
    await openSettings(); openResource();
    fireEvent.change(screen.getByTestId("orch-resource-provider"), { target: { value: "unsafe-provider" } });
    expect(screen.getByTestId("orch-resource-model")).toHaveValue("unsafe-model");
    expect(screen.getByTestId("orch-resource-address")).toHaveValue("https://unsafe.test/v1");
    expect(screen.getByTestId("orch-resource-key")).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("Only Vault references");
    fireEvent.change(screen.getByTestId("orch-resource-provider"), { target: { value: "fixture-provider" } });
    expect(screen.getByTestId("orch-resource-key")).toHaveValue("vault:provider-key");
    fireEvent.change(screen.getByTestId("orch-resource-key"), { target: { value: "secret-not-a-reference" } });
    fireEvent.click(screen.getByTestId("orch-settings-save"));
    expect(screen.getByTestId("orch-settings-error")).toHaveTextContent("Vault-only");
    expect(ipc.saveAgentSettings).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("orch-resource-key"), { target: { value: "vault:new-key" } });
    fireEvent.change(screen.getByTestId("orch-resource-protocol"), { target: { value: "openai_responses" } });
    fireEvent.click(screen.getByTestId("orch-settings-save"));
    await waitFor(() => expect(screen.queryByTestId("orch-settings-dialog")).not.toBeInTheDocument());
    const resource = vi.mocked(ipc.saveAgentSettings).mock.calls[0][0].resources[0];
    expect(resource.keyRef).toBe("vault:new-key");
    expect(resource.protocol).toBe("openai_responses");
    expect(JSON.stringify(vi.mocked(ipc.saveAgentSettings).mock.calls)).not.toContain("plaintext-secret");
    expect(useAiStore.getState().config?.llm.providers["fixture-provider"].api_key).toBe("vault:provider-key");
  });

  it("persists resource-specific proxy through the shared editor without changing application settings", async () => {
    await openSettings(); openResource();
    expect(screen.getByTestId("orch-resource-proxy")).toHaveValue("app");
    fireEvent.change(screen.getByTestId("orch-resource-proxy"), { target: { value: "custom" } });
    fireEvent.change(screen.getByTestId("shared-proxy-host"), { target: { value: "proxy.project.test" } });
    fireEvent.click(screen.getByTestId("orch-settings-save"));
    await waitFor(() => expect(ipc.saveAgentSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.saveAgentSettings).mock.calls[0][0].resources[0]).toMatchObject({ proxyMode: "custom", customProxy: { enabled: true, host: "proxy.project.test", port: 3128 } });
    fireEvent.click(await screen.findByTestId("orch-settings-open")); openResource();
    fireEvent.change(screen.getByTestId("orch-resource-proxy"), { target: { value: "none" } });
    expect(screen.queryByTestId("orch-resource-custom-proxy")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("orch-settings-save"));
    await waitFor(() => expect(ipc.saveAgentSettings).toHaveBeenCalledTimes(2));
    expect(vi.mocked(ipc.saveAgentSettings).mock.calls[1][0].resources[0].proxyMode).toBe("none");
  });

  it("keeps a failed CAS save open with its draft and actionable backend error", async () => {
    vi.mocked(ipc.saveAgentSettings).mockRejectedValue(new Error("Revision conflict: reload shared settings"));
    await openSettings();
    fireEvent.change(screen.getByTestId("orch-plan-name"), { target: { value: "Unsaved new defaults" } });
    fireEvent.click(screen.getByTestId("orch-settings-save"));
    expect(await screen.findByTestId("orch-settings-error")).toHaveTextContent("Revision conflict");
    expect(screen.getByTestId("orch-settings-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("orch-plan-name")).toHaveValue("Unsaved new defaults");
    expect(useOrchestrationStore.getState().settings?.name).toBe("Daily development");
  });

  it("removes references to a deleted resource and blocks saving an incomplete plan", async () => {
    await openSettings(); openResource();
    fireEvent.click(screen.getByTestId("orch-resource-remove"));
    fireEvent.click(screen.getByTestId("orch-settings-save"));
    expect(screen.getByTestId("orch-settings-error")).toBeInTheDocument();
    expect(ipc.saveAgentSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("orch-settings-defaults"));
    expect(screen.getByTestId("orch-planning-resource")).toHaveValue("");
  });

  it("respects late initial settings without replacing an existing unsaved draft", async () => {
    const view = await openSettings();
    expect(view).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("orch-plan-name"), { target: { value: "Draft" } });
    act(() => useOrchestrationStore.setState({ settings: { ...settingsFixture(), revision: 4, name: "Remote defaults" } }));
    expect(screen.getByTestId("orch-plan-name")).toHaveValue("Draft");
  });

  it("matches the backend concurrency limit and rejects 5 before IPC", async () => {
    await openSettings();
    const input = screen.getByTestId("orch-concurrency");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "4");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("orch-settings-save"));
    expect(screen.getByTestId("orch-settings-error")).toBeInTheDocument();
    expect(ipc.saveAgentSettings).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.click(screen.getByTestId("orch-settings-save"));
    await waitFor(() => expect(ipc.saveAgentSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.saveAgentSettings).mock.calls[0][0].concurrency).toBe(4);
  });

  it("validates finite cost, concurrency and proxy credential references", () => {
    const valid = settingsFixture();
    expect(hasValidAgentSettings(valid)).toBe(true);
    expect(hasValidAgentSettings({ ...valid, concurrency: 0 })).toBe(false);
    expect(hasValidAgentSettings({ ...valid, concurrency: 4 })).toBe(true);
    expect(hasValidAgentSettings({ ...valid, concurrency: 5 })).toBe(false);
    expect(hasValidAgentSettings({ ...valid, concurrency: 1.5 })).toBe(false);
    expect(hasValidAgentSettings({ ...valid, resources: valid.resources.map((resource) => ({ ...resource, costCoefficient: NaN })) })).toBe(false);
    expect(hasValidAgentSettings({ ...valid, resources: valid.resources.map((resource) => ({ ...resource, customProxy: { enabled: true, mode: "manual", session_id: "", kind: "http", host: "proxy.test", port: 3128, username: "", password_ref: "plaintext" } })) })).toBe(false);
  });
});
