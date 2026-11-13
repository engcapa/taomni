import { describe, expect, it } from "vitest";
import { classifyFile, fileExtension, supportsFileViewer } from "./classifyFile";
import { documentPathKey } from "./pathIdentity";
import { normalizeViewerText, viewerTextForDisk } from "../viewer";

describe("file opening classification and identity", () => {
  it.each([
    ["/tmp/a.PNG", "image"], ["C:\\docs\\logo.SvG", "svg"], ["/a.markdown", "markdown"],
    ["/a.htm", "html"], ["/a.log", "text"], ["/a.json", "text"], ["/.env.local", "text"],
    ["/README", "text"], ["/LICENSE", "text"], ["/a.rs", "source"], ["/Dockerfile", "source"],
    ["/a.pdf", "pdf"], ["/a.xlsx", "binary"], ["/unknown", "binary"],
  ])("classifies %s as %s", (path, kind) => expect(classifyFile(path)).toBe(kind));
  it("keeps unknown and P1 types external", () => {
    expect(supportsFileViewer("pdf")).toBe(false);
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
