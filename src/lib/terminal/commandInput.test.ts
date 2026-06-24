import { describe, expect, it } from "vitest";
import { buildInteractiveCommandInput } from "./commandInput";

describe("buildInteractiveCommandInput", () => {
  it("submits a single command with carriage return", () => {
    expect(buildInteractiveCommandInput("Get-Host | Select-Object Version")).toBe(
      "Get-Host | Select-Object Version\r",
    );
  });

  it("does not add an extra enter when the command already has a trailing newline", () => {
    expect(buildInteractiveCommandInput("pwd\n")).toBe("pwd\r");
    expect(buildInteractiveCommandInput("pwd\r\n")).toBe("pwd\r");
  });

  it("normalizes multiline commands to repeated terminal enters", () => {
    expect(buildInteractiveCommandInput("echo one\n$PSVersionTable.PSVersion")).toBe(
      "echo one\r$PSVersionTable.PSVersion\r",
    );
  });

  it("preserves intentional blank lines inside the command", () => {
    expect(buildInteractiveCommandInput("cat <<'EOF'\n\nEOF")).toBe("cat <<'EOF'\r\rEOF\r");
  });
});
