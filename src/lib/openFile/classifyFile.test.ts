import { describe, expect, it } from "vitest";
import { classifyFile, fileExtension, supportsFileViewer } from "./classifyFile";
import { documentPathKey } from "./pathIdentity";
import { normalizeViewerText, viewerTextForDisk } from "../viewer";
import { archiveFolderName } from "./archiveFormats";

describe("file opening classification and identity", () => {
  it.each([
    ["/tmp/a.PNG", "image"], ["C:\\docs\\logo.SvG", "svg"], ["/a.markdown", "markdown"],
    ["/a.htm", "html"], ["/a.log", "text"], ["/a.json", "text"], ["/.env.local", "text"],
    ["/README", "text"], ["/LICENSE", "text"], ["/a.rs", "source"], ["/Dockerfile", "source"],
    ["/a.pdf", "pdf"], ["/a.xlsx", "document"], ["/unknown", "binary"],
    ["/a.CBZ", "archive"], ["/a.tar", "archive"], ["/a.TAR.GZ", "archive"],
    ["/a.7Z", "archive"],
    ["/a.tgz", "archive"], ["/a.tar.bz2", "archive"], ["/a.tar.xz", "archive"], ["/a.tar.zst", "archive"],
    ["/a.txt.gz", "archive"], ["/a.txt.bz2", "archive"], ["/a.txt.xz", "archive"],
    ["/a.txt.zst", "archive"], ["/a.tar.gz.txt", "text"],
  ])("classifies %s as %s", (path, kind) => expect(classifyFile(path)).toBe(kind));
  it.each(["quarter.2026.TAR.GZ", "quarter.2026.tar.xz", "quarter.2026.tgz", "quarter.2026.zip"])(
    "uses the archive's base name for the extraction directory (%s)",
    (name) => expect(archiveFolderName(name)).toBe("quarter.2026"),
  );
  it("opens document types in a viewer and keeps unknown types external", () => {
    expect(supportsFileViewer("pdf")).toBe(true);
    expect(supportsFileViewer("binary")).toBe(false);
    expect(supportsFileViewer("source")).toBe(false);
    expect(supportsFileViewer("markdown")).toBe(true);
  });
  it("folds Windows path spelling but never folds Unix case", () => {
    expect(documentPathKey("C:\\Docs\\A.TXT\\")).toBe("c:/docs/a.txt");
    expect(documentPathKey("\\\\?\\UNC\\server\\share\\A")).toBe("//server/share/a");
    expect(documentPathKey("/Docs/A.txt")).not.toBe(documentPathKey("/docs/a.txt"));
    expect(documentPathKey("/")).toBe("/");
    expect(fileExtension("C:\\Docs\\A.MD")).toBe("md");
  });
  it("round trips mixed line endings without normalizing saved source", () => {
    const content = normalizeViewerText("a\r\nb\nc\rd");
    expect(content).toBe("a\nb\nc\nd");
    expect(viewerTextForDisk({ content, eol: "mixed", originalLineEndings: ["\r\n", "\n", "\r"] })).toBe("a\r\nb\nc\rd");
  });
});
