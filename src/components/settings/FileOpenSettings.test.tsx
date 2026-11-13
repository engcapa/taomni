import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./AppProxyPanel", () => ({ AppProxyPanel: ({ value, onSave }: { value: { host: string }; onSave: (value: object) => Promise<void> }) => <input data-testid="feature-custom-proxy-host" value={value.host} onChange={(event) => { void onSave({ ...value, host: event.target.value }); }} /> }));
import { setLocale } from "../../lib/i18n";
import { FILE_OPEN_PREFERENCES_KEY, resetFileOpenPreferences, useFileOpenPreferences } from "../../lib/openFile/preferences";
import { FileOpenSettings } from "./FileOpenSettings";

beforeEach(() => { setLocale("en"); resetFileOpenPreferences(); });
afterEach(() => cleanup());

describe("global file-opening settings", () => {
  it("persists handlers, Markdown, editor and HTML preferences immediately and resets", () => {
    render(<FileOpenSettings />);
    fireEvent.click(screen.getByTestId("file-open-default-system"));
    fireEvent.change(screen.getByTestId("file-open-association-svg"), { target: { value: "workspace" } });
    fireEvent.change(screen.getByTestId("file-open-image-dir"), { target: { value: "images" } });
    fireEvent.change(screen.getByTestId("file-open-image-template"), { target: { value: "paste-{date}-{time}.png" } });
    fireEvent.change(screen.getByTestId("file-open-html-network"), { target: { value: "ask" } });
    fireEvent.click(screen.getByTestId("file-open-html-scripts"));
    fireEvent.click(screen.getByTestId("file-open-convert-tables"));
    fireEvent.click(screen.getByTestId("file-open-wrap"));
    fireEvent.change(screen.getByTestId("file-open-font-size"), { target: { value: "16" } });
    expect(JSON.parse(localStorage.getItem(FILE_OPEN_PREFERENCES_KEY)!)).toMatchObject({
      defaultHandler: "system", associations: { svg: "workspace" }, markdownImageDir: "images",
      markdownImageTemplate: "paste-{date}-{time}.png", htmlNetwork: "ask", htmlScripts: false,
      convertTables: false, wrap: false, fontSize: 16,
    });
    fireEvent.click(screen.getByTestId("file-open-settings-reset"));
    expect(useFileOpenPreferences.getState()).toMatchObject({ defaultHandler: "taomni", associations: {}, markdownImageDir: "assets", htmlScripts: true, wrap: true, fontSize: 13 });
    expect(screen.getByTestId("file-open-default-taomni")).toHaveAttribute("aria-checked", "true");
  });

  it("allows real clear-then-type replacements without reinserting validated defaults", () => {
    render(<FileOpenSettings />);
    for (const [testId, value] of [["file-open-image-dir", "images"], ["file-open-image-template", "paste-{date}-{time}.png"], ["file-open-font-size", "16"]]) {
      const input = screen.getByTestId(testId) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "" } });
      expect(input.value).toBe("");
      fireEvent.change(input, { target: { value } });
      expect(input.value).toBe(value);
    }
    expect(useFileOpenPreferences.getState()).toMatchObject({ markdownImageDir: "images", markdownImageTemplate: "paste-{date}-{time}.png", fontSize: 16 });
    fireEvent.click(screen.getByTestId("file-open-settings-reset"));
    expect(screen.getByTestId("file-open-image-dir")).toHaveValue("assets");
    expect(screen.getByTestId("file-open-font-size")).toHaveValue(13);
  });
  it("changes individual extensions without replacing their group and rejects invalid keys", () => {
    render(<FileOpenSettings />);
    fireEvent.change(screen.getByTestId("file-open-extension"), { target: { value: "../txt" } });
    fireEvent.click(screen.getByTestId("file-open-association-add"));
    expect(screen.getByRole("alert")).toHaveTextContent("valid file extension");
    fireEvent.change(screen.getByTestId("file-open-extension"), { target: { value: ".TXT" } });
    fireEvent.change(screen.getByTestId("file-open-extension-handler"), { target: { value: "system" } });
    fireEvent.click(screen.getByTestId("file-open-association-add"));
    expect(useFileOpenPreferences.getState().associations).toEqual({ txt: "system" });
    expect(screen.getByTestId("file-open-association-text")).toHaveValue("mixed");
  });

  it("persists independent proxy modes without changing application proxy settings", () => {
    localStorage.setItem("taomni.appProxy", "unchanged");
    render(<FileOpenSettings />);
    expect(screen.getByTestId("html-preview-proxy-mode")).toHaveValue("app");
    fireEvent.change(screen.getByTestId("html-preview-proxy-mode"), { target: { value: "custom" } });
    fireEvent.change(screen.getByTestId("feature-custom-proxy-host"), { target: { value: "feature.proxy" } });
    fireEvent.change(screen.getByTestId("html-preview-proxy-mode"), { target: { value: "none" } });
    expect(useFileOpenPreferences.getState()).toMatchObject({ htmlProxyMode: "none", htmlCustomProxy: { host: "feature.proxy" } });
    fireEvent.change(screen.getByTestId("html-preview-proxy-mode"), { target: { value: "custom" } });
    expect(screen.getByTestId("feature-custom-proxy-host")).toHaveValue("feature.proxy");
    expect(localStorage.getItem("taomni.appProxy")).toBe("unchanged");
  });
  it("uses the reviewed Chinese prototype labels", () => {
    setLocale("zh-CN");
    render(<FileOpenSettings />);
    expect(screen.getByRole("heading", { name: "文件与打开方式" })).toBeInTheDocument();
    expect(screen.getByText("Ctrl/⌘ + 双击 取另一种")).toBeInTheDocument();
    expect(screen.getByText("在隔离沙盒中运行")).toBeInTheDocument();
  });
});
