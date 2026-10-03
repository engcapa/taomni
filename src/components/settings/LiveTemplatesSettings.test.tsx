import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY } from "../../lib/liveTemplatePreferences";
import { refreshLiveTemplatePreferencesCache } from "../editor/workspace/liveTemplates";
import { LiveTemplatesSettings } from "./LiveTemplatesSettings";

beforeEach(() => {
  window.localStorage.removeItem(LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY);
  refreshLiveTemplatePreferencesCache();
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY);
  refreshLiveTemplatePreferencesCache();
});

describe("LiveTemplatesSettings", () => {
  it("lists built-in Java templates and can disable one", () => {
    render(<LiveTemplatesSettings />);
    expect(screen.getByTestId("live-templates-settings")).toBeInTheDocument();
    expect(screen.getByTestId("live-templates-enabled")).toBeChecked();

    // Default filter is Java — sout should appear.
    const soutRow = screen.getByTestId("live-template-builtin-java|l|sout");
    const checkbox = within(soutRow).getByTestId("live-template-builtin-enabled-java|l|sout");
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    const stored = JSON.parse(
      window.localStorage.getItem(LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY) ?? "{}",
    );
    expect(stored.disabledBuiltinKeys).toContain("java|l|sout");
  });

  it("adds a custom template", () => {
    render(<LiveTemplatesSettings />);
    fireEvent.click(screen.getByTestId("live-templates-add-custom"));
    fireEvent.change(screen.getByTestId("live-template-custom-abbreviation"), {
      target: { value: "mysout" },
    });
    fireEvent.change(screen.getByTestId("live-template-custom-body"), {
      target: { value: "System.out.println(\"hi\");" },
    });
    fireEvent.change(screen.getByTestId("live-template-custom-description"), {
      target: { value: "My print" },
    });
    fireEvent.click(screen.getByTestId("live-template-custom-save"));

    expect(screen.getByText("mysout")).toBeInTheDocument();
    const stored = JSON.parse(
      window.localStorage.getItem(LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY) ?? "{}",
    );
    expect(stored.customTemplates?.[0]?.abbreviation).toBe("mysout");
  });

  it("rejects invalid custom abbreviations", () => {
    render(<LiveTemplatesSettings />);
    fireEvent.click(screen.getByTestId("live-templates-add-custom"));
    fireEvent.change(screen.getByTestId("live-template-custom-abbreviation"), {
      target: { value: "bad name" },
    });
    fireEvent.change(screen.getByTestId("live-template-custom-body"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("live-template-custom-save"));
    expect(screen.getByTestId("live-template-custom-error")).toBeInTheDocument();
  });

  it("resets to defaults", () => {
    render(<LiveTemplatesSettings />);
    fireEvent.click(screen.getByTestId("live-templates-enabled"));
    expect(screen.getByTestId("live-templates-enabled")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("live-templates-reset"));
    expect(screen.getByTestId("live-templates-enabled")).toBeChecked();
  });
});
