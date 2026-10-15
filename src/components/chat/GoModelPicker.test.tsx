import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoCatalogStatus, GoModelPicker, effectiveGoModels } from "./GoModelPicker";
import { useOpencodeGoStore } from "../../stores/opencodeGoStore";
import { GO_STUB_CATALOG } from "../../stubs/opencodeGoStub";
const ensureLoaded = vi.fn().mockResolvedValue(undefined);
const refresh = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.clearAllMocks();
  useOpencodeGoStore.setState({ ...GO_STUB_CATALOG, loaded: true, loading: false, ensureLoaded, refresh });
});
afterEach(cleanup);
describe("Go model selector", () => {
  it("displays effective override protocols, including unknown-value chat fallback", () => {
    const models = effectiveGoModels(GO_STUB_CATALOG.models, { "deepseek-v4.1-flash":"messages", "grok-4.7":"future" });
    expect(models[0].protocol).toBe("messages");
    expect(models.find((m) => m.id === "grok-4.7")?.protocol).toBe("chat");
    expect(models[0].protocol_source).toBe("user_override");
    expect(GO_STUB_CATALOG.models[0].protocol).toBe("chat");
  });
  it("searches grouped models and renders deprecated/unclassified/training badges", () => {
    render(<GoModelPicker value="kimi-k3" defaultModel="deepseek-v4.1-flash" onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: /gemini.*May be used for training/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /kimi-k2.6.*Deprecated/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /omen-alpha.*Unclassified/ })).toBeTruthy();
    fireEvent.change(screen.getByTestId("go-default-model-search"), { target: { value: "google" } });
    expect(screen.queryByRole("option", { name: /grok/ })).toBeNull();
    expect(screen.getByRole("option", { name: /gemini/ })).toBeTruthy();
    expect(screen.getByTestId("go-default-model-select")).toHaveValue("kimi-k3");
  });
  it("keeps unlisted pins first; explicitly clears to default without automatic substitution", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<GoModelPicker value="retired-model" inherit defaultModel="deepseek-v4.1-flash" onChange={onChange} />);
    const select = screen.getByTestId("go-default-model-select") as HTMLSelectElement;
    expect(select.options[1].text).toContain("No longer listed?");
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => fireEvent.change(select, { target: { value: "" } }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
  it("supports empty directory text entry and surfaces save failure", async () => {
    useOpencodeGoStore.setState({ models: [] });
    render(<GoModelPicker value="custom" defaultModel="custom" onChange={vi.fn().mockRejectedValue(new Error("disk failure"))} />);
    await act(async () => fireEvent.change(screen.getByTestId("go-default-model-fallback"), { target: { value: "new" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("disk failure");
  });
  it("shows local-policy, loading and last-good failure states; refresh is disabled", () => {
    useOpencodeGoStore.setState({ loading: true, last_error: "offline" });
    render(<GoCatalogStatus blocked />);
    expect(screen.getByTestId("go-catalog-refresh")).toBeDisabled();
    expect(screen.getByTestId("go-catalog-error")).toHaveTextContent("offline");
    expect(screen.getByTestId("go-catalog-blocked")).toBeTruthy();
  });
});
