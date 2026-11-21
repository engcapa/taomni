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
  UnavailableFileHandlerError,
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
  it("registers notepad & taoffice, scopes TaOffice to office extensions, and throws explicit error when unavailable", async () => {
    expect(isHandlerAvailable("notepad")).toBe(true);
    expect(isHandlerAvailable("taoffice")).toBe(false);
    expect(getFileHandler("taoffice")?.inDevelopment).toBe(true);
    expect(isOfficeExtension("report.docx")).toBe(true);
    expect(isOfficeExtension("sheet.csv")).toBe(true);
    expect(isOfficeExtension("notes.txt")).toBe(false);
    expect(listFileHandlers("txt").some((h) => h.id === "taoffice")).toBe(false);
    expect(listFileHandlers("docx").some((h) => h.id === "taoffice")).toBe(true);

    setFileOpenPreferences({ associations: { docx: "taoffice" } });
    expect(useFileOpenPreferences.getState().associations.docx).toBe("taoffice");
    await expect(openFile({ path: "/docs/weekly.docx" }, { context: "explorer" })).rejects.toBeInstanceOf(
      UnavailableFileHandlerError,
    );
  });

  it("exposes TaOffice disabled item only for office extensions in fileOpenMenu", () => {
    const label = (_zh: string, en: string) => en;
    const docxItems = fileOpenMenu("/docs/report.docx", undefined, label, () => {});
    const txtItems = fileOpenMenu("/docs/notes.txt", undefined, label, () => {});

    const taofficeDocx = docxItems.find((item) => item.testId === "file-open-with-taoffice");
    expect(taofficeDocx).toBeDefined();
    expect(taofficeDocx?.disabled).toBe(true);
    expect(taofficeDocx?.label).toContain("In development");
    expect(docxItems.some((item) => item.testId === "file-open-with-notepad")).toBe(true);

    expect(txtItems.some((item) => item.testId === "file-open-with-taoffice")).toBe(false);
    expect(txtItems.find((item) => item.testId === "file-open-with-taomni")?.label).toBe("Taomni Notepad");
  });

  it("shows Notepad & disabled TaOffice options in FileOpenSettings and opens untitled documents", () => {
    render(<FileOpenSettings />);
    const dataSelect = screen.getByTestId("file-open-association-data") as HTMLSelectElement;
    const taofficeOpt = Array.from(dataSelect.options).find((o) => o.value === "taoffice");
    expect(taofficeOpt).toBeDefined();
    expect(taofficeOpt?.disabled).toBe(true);
    expect(taofficeOpt?.textContent).toContain("In development");

    fireEvent.change(screen.getByTestId("file-open-association-text"), { target: { value: "notepad" } });
    expect(useFileOpenPreferences.getState().associations.txt).toBe("notepad");

    const docId = openUntitledNotepadDocument({ host: "explorer" });
    expect(docId.startsWith("untitled:")).toBe(true);
    expect(useExplorerStore.getState().tabs[0].fileViewer).toMatchObject({ path: docId, untitled: true, mode: "notepad" });
  });
});
