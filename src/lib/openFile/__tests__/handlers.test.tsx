import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fileOpenMenu } from "../../../components/explorer/fileOpenMenu";
import { FileOpenSettings } from "../../../components/settings/FileOpenSettings";
import { setLocale } from "../../i18n";
import {
  getFileHandler,
  isHandlerAvailable,
  isOfficeExtension,
  listFileHandlers,
  openFile,
  openUntitledNotepadDocument,
} from "../index";
import { resetFileOpenPreferences, setFileOpenPreferences, useFileOpenPreferences } from "../preferences";
import { useAppStore } from "../../../stores/appStore";
import { useExplorerStore } from "../../../stores/explorerStore";
import { useDocumentStore } from "../../../stores/documentStore";

vi.mock("../../explorer", () => ({ explorerCanonicalPath: vi.fn(async (path: string) => path) }));
vi.mock("../../sftp", async (original) => ({ ...await original<typeof import("../../sftp")>(), sftpOpenPath: vi.fn(async () => {}) }));

beforeEach(() => {
  localStorage.clear();
  resetFileOpenPreferences();
  setLocale("en");
  useAppStore.setState({ tabs: [], activeTabId: null, activeSideTab: "explorer" });
  useExplorerStore.setState({ tabs: [], activeTabId: null });
  useDocumentStore.setState({ documents: {} });
});
afterEach(() => cleanup());

describe("FileHandlerRegistry and Open With integration (V-49 / V-50)", () => {
  it("routes a stored office association to an independent document tab and keeps core text formats", async () => {
    expect(isHandlerAvailable("notepad")).toBe(true);
    expect(isHandlerAvailable("taoffice")).toBe(true);
    expect(getFileHandler("taoffice")?.inDevelopment).toBeFalsy();
    expect(isOfficeExtension("report.docx")).toBe(true);
    expect(isOfficeExtension("sheet.csv")).toBe(false);
    expect(isOfficeExtension("notes.txt")).toBe(false);
    expect(listFileHandlers("txt").some((h) => h.id === "taoffice")).toBe(false);
    expect(listFileHandlers("docx").some((h) => h.id === "taoffice")).toBe(true);

    setFileOpenPreferences({ associations: { docx: "taoffice" } });
    expect(useFileOpenPreferences.getState().associations.docx).toBe("taoffice");
    await openFile("/docs/weekly.docx", { context: "explorer" });
    await openFile("/docs/another.docx", { context: "explorer" });
    await openFile("/docs/weekly.docx", { context: "explorer" });
    const tabs = useExplorerStore.getState();
    expect(tabs.tabs.map((tab) => tab.fileViewer?.kind)).toEqual(["document", "document"]);
    expect(tabs.activeTabId).toBe(tabs.tabs[0].id);
  });

  it("names the responsible document module in Open With", () => {
    const label = (_zh: string, en: string) => en;
    const docxItems = fileOpenMenu("/docs/report.docx", undefined, label, () => {});
    const txtItems = fileOpenMenu("/docs/notes.txt", undefined, label, () => {});

    const taofficeDocx = docxItems.find((item) => item.testId === "file-open-with-taoffice");
    expect(taofficeDocx).toBeDefined();
    expect(taofficeDocx?.disabled).toBeFalsy();
    expect(taofficeDocx?.label).toContain("Word");
    expect(docxItems.some((item) => item.testId === "file-open-with-notepad")).toBe(true);

    expect(txtItems.some((item) => item.testId === "file-open-with-taoffice")).toBe(false);
    expect(txtItems.find((item) => item.testId === "file-open-with-taomni")?.label).toBe("Taomni Notepad");
  });

  it("offers TaOffice for document associations and opens untitled Notepad documents", () => {
    render(<FileOpenSettings />);
    const dataSelect = screen.getByTestId("file-open-association-binary") as HTMLSelectElement;
    const taofficeOpt = Array.from(dataSelect.options).find((o) => o.value === "taoffice");
    expect(taofficeOpt).toBeDefined();
    expect(taofficeOpt?.disabled).toBe(false);
    expect(taofficeOpt?.textContent).toBe("TaOffice");

    fireEvent.change(screen.getByTestId("file-open-association-text"), { target: { value: "notepad" } });
    expect(useFileOpenPreferences.getState().associations.txt).toBe("notepad");

    const docId = openUntitledNotepadDocument({ host: "explorer" });
    expect(docId.startsWith("untitled:")).toBe(true);
    expect(useExplorerStore.getState().tabs[0].fileViewer).toMatchObject({ path: docId, untitled: true, mode: "notepad" });
  });
});
