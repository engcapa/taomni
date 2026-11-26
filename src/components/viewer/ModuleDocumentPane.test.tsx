import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { deferred, moduleRecord } from "../../lib/tests/pluginFrontendHarness";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import { viewerReadBytes, type ViewerBytes } from "../../lib/viewer";
import { sftpOpenPath } from "../../lib/sftp";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { ModuleDocumentPane, type ModuleDocumentInput } from "./ModuleDocumentPane";

let attached: ModuleDocumentInput["document"];
vi.mock("../plugins/PluginTabPane", () => ({
  PluginTabPane: ({ componentProps }: { componentProps: ModuleDocumentInput }) => {
    attached = componentProps.document;
    return <p>{attached.name}</p>;
  },
}));
vi.mock("../../lib/sftp", async (original) => ({
  ...await original<typeof import("../../lib/sftp")>(), sftpOpenPath: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/settingsNavigation", () => ({ openSettingsSection: vi.fn() }));
vi.mock("../../lib/viewer", () => ({ viewerReadBytes: vi.fn() }));

const viewer = { path: "/tmp/ledger.xlsx", kind: "document" as const };
const slug = "taoffice-excel";
function install(lifecycle: "disabled" | "enabled") {
  const record = moduleRecord(lifecycle);
  record.slug = slug;
  record.manifest = { ...record.manifest!, slug, id: `taomni-plugin-${slug}`, name: "Excel",
    document: { fileKinds: ["excel"], extensions: ["xlsx"] }, permissions: ["fs.readUserFile"] };
  usePluginFrontendStore.setState({ records: { [slug]: record } });
}

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  usePluginFrontendStore.setState({ status: "ready", pending: new Set(), records: {}, epochs: {}, attach: () => () => {} });
});
afterEach(cleanup);

it("shows the document owner and lets the user explicitly open the store or system app", async () => {
  render(<ModuleDocumentPane viewer={viewer} active />);
  expect(screen.getByText("Excel is not installed")).toBeVisible();
  expect(viewerReadBytes).not.toHaveBeenCalled();
  expect(sftpOpenPath).not.toHaveBeenCalled();
  act(() => install("disabled"));
  expect(screen.getByText("Excel is disabled")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open module store" }));
  expect(openSettingsSection).toHaveBeenCalledWith("module-store");
  vi.mocked(sftpOpenPath).mockRejectedValueOnce(new Error("no association"));
  fireEvent.click(screen.getByRole("button", { name: "Open in system app" }));
  expect(sftpOpenPath).toHaveBeenCalledWith(viewer.path);
  expect(await screen.findByRole("alert")).toHaveTextContent("no association");
});

it("invalidates pending reads and prevents another read after disable or close", async () => {
  install("enabled");
  const view = render(<ModuleDocumentPane viewer={{ ...viewer, source: "remote-temp" }} active />);
  expect(screen.getByTestId("document-readonly")).toBeVisible();
  expect(attached.readOnly).toBe(true);
  const first = attached;
  const pending = deferred<ViewerBytes>();
  vi.mocked(viewerReadBytes).mockReturnValueOnce(pending.promise);
  const read = first.read();
  expect(viewerReadBytes).toHaveBeenCalledWith(viewer.path);
  act(() => install("disabled"));
  pending.resolve({ bytes: [42], mime: "application/octet-stream", size: 1 });
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
  await expect(first.read()).rejects.toMatchObject({ name: "AbortError" });
  act(() => install("enabled"));
  expect(attached).not.toBe(first);
  view.unmount();
  await expect(attached.read()).rejects.toMatchObject({ name: "AbortError" });
  expect(viewerReadBytes).toHaveBeenCalledTimes(1);
});
