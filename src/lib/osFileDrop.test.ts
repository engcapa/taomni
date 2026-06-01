import { describe, expect, it, vi } from "vitest";
import {
  droppedFilePaths,
  formatDroppedPathsForShell,
  isOsFileDrag,
  parseUriList,
  preventDefaultForOsFileDrag,
  quotePathForShell,
  shellQuoteStyleForTerminalDrop,
  type DataTransferLike,
} from "./osFileDrop";

describe("osFileDrop", () => {
  it("detects OS file drags and ignores app-internal drags", () => {
    expect(isOsFileDrag({ types: ["Files"] })).toBe(true);
    expect(isOsFileDrag({ types: ["text/uri-list"] })).toBe(true);
    expect(isOsFileDrag({ types: ["application/x-taomni-files", "text/plain"] })).toBe(false);
  });

  it("prevents default navigation only for OS file drags", () => {
    const preventDefault = vi.fn();
    preventDefaultForOsFileDrag({ dataTransfer: { types: ["Files"] }, preventDefault });
    preventDefaultForOsFileDrag({
      dataTransfer: { types: ["application/x-taomni-files"] },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("parses text/uri-list into file paths", () => {
    expect(parseUriList("# comment\nfile:///home/me/a%20b.png\r\nhttps://example.test/x")).toEqual([
      "/home/me/a b.png",
      "https://example.test/x",
    ]);
  });

  it("prefers uri-list paths over file names for dropped terminal paths", () => {
    const file = new File(["x"], "a b.png");
    const dataTransfer: DataTransferLike = {
      types: ["Files", "text/uri-list"],
      files: [file],
      getData: (format) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    expect(droppedFilePaths(dataTransfer)).toEqual(["/home/me/a b.png"]);
  });

  it("quotes dropped paths for common shell families", () => {
    expect(quotePathForShell("/tmp/a b's.png", "unix")).toBe("'/tmp/a b'\\''s.png'");
    expect(quotePathForShell("C:\\Users\\Me\\a'b.png", "powershell")).toBe("'C:\\Users\\Me\\a''b.png'");
    expect(quotePathForShell("C:\\100% ready^!.png", "cmd")).toBe('"C:\\100%% ready^^^!.png"');
  });

  it("formats multiple paths with a trailing insertion space", () => {
    expect(formatDroppedPathsForShell(["/tmp/a.png", "/tmp/b.png"], "unix")).toBe(
      "'/tmp/a.png' '/tmp/b.png' ",
    );
  });

  it("chooses shell quote style from terminal context", () => {
    expect(shellQuoteStyleForTerminalDrop({ isSsh: true, localShellId: "powershell" })).toBe("unix");
    expect(shellQuoteStyleForTerminalDrop({ isSsh: false, localShellId: "powershell" })).toBe("powershell");
    expect(shellQuoteStyleForTerminalDrop({ isSsh: false, localShellId: "command-prompt" })).toBe("cmd");
    expect(shellQuoteStyleForTerminalDrop({ isSsh: false, localShellId: "git-bash" })).toBe("unix");
  });
});
