import { describe, it, expect } from "vitest";
import { formatCcTerminalEcho, fmtBytes, type CcTerminalEcho } from "./ccEcho";

function sample(overrides: Partial<CcTerminalEcho> = {}): CcTerminalEcho {
  return {
    sessionId: "ssh-tab-1",
    threadId: "thread-1",
    captureId: "cap-1",
    command: "uname -a",
    head: "Linux raspi 6.1.21-v8+",
    lines: 1,
    bytes: 23,
    truncated: false,
    exitCode: 0,
    status: "Done",
    ...overrides,
  };
}

describe("formatCcTerminalEcho", () => {
  it("frames the command header and output on their own lines", () => {
    const out = formatCcTerminalEcho(sample());
    // Leads and trails with CRLF so it never appends to a half-drawn prompt.
    expect(out.startsWith("\r\n")).toBe(true);
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out).toContain("┃ [CC] $ uname -a");
    expect(out).toContain("Linux raspi 6.1.21-v8+");
    // Uses CRLF between lines (xterm needs the carriage return).
    expect(out).toContain("\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it("footer reports exit code, line count and size for a clean run", () => {
    const out = formatCcTerminalEcho(sample({ lines: 1, bytes: 23 }));
    expect(out).toContain("exit=0");
    expect(out).toContain("共 1 行");
  });

  it("notes hidden lines and points at the chat when output exceeds the head", () => {
    const head = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = formatCcTerminalEcho(sample({ head, lines: 148, bytes: 4096 }));
    expect(out).toContain("+128 行未显示");
    expect(out).toContain("完整见对话 / read_capture");
  });

  it("marks truncation", () => {
    const out = formatCcTerminalEcho(sample({ truncated: true, lines: 999999 }));
    expect(out).toContain("已截断");
  });

  it("labels a failed run and an unknown exit code", () => {
    const out = formatCcTerminalEcho(sample({ status: "Failed", exitCode: null, head: "" }));
    expect(out).toContain("失败");
    expect(out).toContain("exit=?");
  });

  it("handles empty output", () => {
    const out = formatCcTerminalEcho(sample({ head: "", lines: 0, bytes: 0 }));
    expect(out).toContain("无输出");
    // No bogus "共 0 行" line-count noise when there is nothing to show.
    expect(out).not.toContain("共 0 行");
  });

  it("collapses a multi-line command into a single header line", () => {
    const out = formatCcTerminalEcho(sample({ command: "for i in 1 2 3; do\n  echo $i\ndone" }));
    const header = out.split("\r\n").find((l) => l.includes("[CC] $"))!;
    expect(header).toContain("for i in 1 2 3; do   echo $i done");
  });
});

describe("fmtBytes", () => {
  it("formats byte magnitudes", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(fmtBytes(-1)).toBe("0 B");
  });
});
